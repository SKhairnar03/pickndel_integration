"use strict";

require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const orderRoutes = require("./routes/orderRoutes");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Database ─────────────────────────────────────────────────────────────────
if (process.env.MONGODB_URI) {
    mongoose
        .connect(process.env.MONGODB_URI)
        .then(() => console.log("✅ MongoDB connected successfully"))
        .catch((err) => console.error("❌ MongoDB connection error:", err));
} else {
    console.warn("⚠️  No MONGODB_URI found. Webhook savings will fail.");
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Request logger (dev) ─────────────────────────────────────────────────────
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
// Order management routes:  /orders/auth/login, /orders/place, /orders/status
app.use("/orders", orderRoutes);

// Webhook route sits at the top-level path expected by PIKNDEL
app.use("/webhooks", orderRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", service: "pikndel-integration" }));

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: "Route not found." }));

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error("[Global Error]", err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅  PIKNDEL Integration server running on port ${PORT}`);
    console.log(`   Health check → http://localhost:${PORT}/health`);
});

module.exports = app;
