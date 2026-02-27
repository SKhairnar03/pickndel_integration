"use strict";

const express = require("express");
const router = express.Router();
const pikndelService = require("../services/pikndelService");

// ─────────────────────────────────────────────────────────────────────────────
// Helper – unified success / error response
// ─────────────────────────────────────────────────────────────────────────────
function sendSuccess(res, data, statusCode = 200) {
    return res.status(statusCode).json({ success: true, data });
}

function sendError(res, err) {
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({
        success: false,
        error: err.message,
        pikndelData: err.pikndelData || null,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Authentication Middleware
// PIKNDEL must send their secret in the header:  x-pikndel-secret: <value>
// Set PIKNDEL_WEBHOOK_SECRET in your .env to the value PIKNDEL gives you.
// ─────────────────────────────────────────────────────────────────────────────
function verifyWebhookSecret(req, res, next) {
    const expectedSecret = process.env.PIKNDEL_WEBHOOK_SECRET;

    // If no secret is configured, skip verification (useful during local dev)
    if (!expectedSecret) {
        console.warn("[PIKNDEL Webhook] ⚠️  PIKNDEL_WEBHOOK_SECRET not set – skipping auth check.");
        return next();
    }

    const incomingSecret = req.headers["x-pikndel-secret"];

    if (!incomingSecret) {
        console.warn("[PIKNDEL Webhook] ❌ Rejected – missing x-pikndel-secret header.");
        return res.status(401).json({ success: false, error: "Unauthorized: missing webhook secret header." });
    }

    if (incomingSecret !== expectedSecret) {
        console.warn("[PIKNDEL Webhook] ❌ Rejected – invalid secret.");
        return res.status(401).json({ success: false, error: "Unauthorized: invalid webhook secret." });
    }

    // ✅ Secret matches – allow request to proceed
    console.log("[PIKNDEL Webhook] ✅ Webhook secret verified.");
    return next();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /orders/auth/login
// Body: { username?, password? }  (falls back to .env)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const { token, userId, name } = await pikndelService.login(username, password);
        return sendSuccess(res, { token, userId, name });
    } catch (err) {
        console.error("[Route /auth/login]", err.message);
        return sendError(res, err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /orders/place
// Body: full orderPayload (see pikndelService.placeOrder for shape)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/place", async (req, res) => {
    try {
        const result = await pikndelService.placeOrder(req.body);
        return sendSuccess(res, result, 200);
    } catch (err) {
        console.error("[Route /orders/place]", err.message);
        return sendError(res, err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /orders/status
// Body: { AWBNo: "..." }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/status", async (req, res) => {
    try {
        const { AWBNo } = req.body || {};
        if (!AWBNo) {
            return res.status(400).json({ success: false, error: "AWBNo is required in request body." });
        }
        const result = await pikndelService.getOrderStatus(AWBNo);
        return sendSuccess(res, result);
    } catch (err) {
        console.error("[Route /orders/status]", err.message);
        return sendError(res, err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/pikndel/status   ← Push webhook from PIKNDEL
// PIKNDEL sends real-time status updates to this endpoint.
//
// Expected payload shape (PIKNDEL Push):
// {
//   "AWBNo": "PKD123456",
//   "short_code": "PCK",       // e.g. NEW, PCK, DLD, RTN …
//   "activity": "Parcel picked up from sender",
//   "timestamp": 1708800000,
//   ... other fields
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/pikndel/status", verifyWebhookSecret, async (req, res) => {
    try {
        const payload = req.body || {};
        const { AWBNo, short_code, activity, timestamp } = payload;

        // ── Log the incoming status push ──────────────────────────────────────
        console.log("──────────────────────────────────────────────────");
        console.log("[PIKNDEL Webhook] Incoming status update");
        console.log(`  AWBNo      : ${AWBNo}`);
        console.log(`  short_code : ${short_code}`);   // e.g. NEW, PCK, DLD
        console.log(`  activity   : ${activity}`);
        console.log(`  timestamp  : ${timestamp}`);
        console.log("  Full payload:", JSON.stringify(payload, null, 2));
        console.log("──────────────────────────────────────────────────");

        const STATUS_MAP = {
            NEW: "Order Created",
            PCK: "Parcel Picked Up",
            OFD: "Out for Delivery",
            DLD: "Delivered",
            RTO: "Return to Origin Initiated",
            RTN: "Returned",
            CAN: "Cancelled",
        };

        const readableStatus = STATUS_MAP[short_code] || short_code;
        console.log(`[PIKNDEL Webhook] Status: ${readableStatus} – ${activity}`);

        // ── Save to MongoDB ───────────────────────────────────────────────────
        const WebhookResponse = require("../models/WebhookResponse");
        try {
            await WebhookResponse.create({
                AWBNo,
                short_code,
                activity,
                timestamp,
                rawPayload: payload,
            });
            console.log("✅ Webhook payload saved to MongoDB -> 'pickndel integration responce file'");
        } catch (dbErr) {
            console.error("❌ Failed to save webhook to MongoDB:", dbErr.message);
        }

        // Always acknowledge immediately so PIKNDEL does not retry
        return res.status(200).json({ success: true, message: "Webhook received and saved." });
    } catch (err) {
        console.error("[PIKNDEL Webhook] Error processing payload:", err.message);
        return res.status(500).json({ success: false, error: "Webhook handler error." });
    }
});

module.exports = router;
