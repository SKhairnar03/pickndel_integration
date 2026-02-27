"use strict";

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const BASE_URL = (process.env.PIKNDEL_BASE_URL || "https://api.pikndel.com").replace(/\/$/, "");

// Runtime JWT token cache (refreshed on login)
let cachedToken = null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the standard PIKNDEL "Control" envelope.
 * @param {string|number} version – endpoint-specific version (e.g. 3.2)
 * @returns {object} Control object
 */
function buildControl(version = 1) {
  return {
    RequestId: uuidv4(),
    Source: Number(process.env.PIKNDEL_SOURCE || 3),
    RequestTime: Math.floor(Date.now() / 1000), // Unix timestamp (seconds)
    Version: String(version),
  };
}

/**
 * Central axios wrapper that:
 *  1. Injects the Control envelope into every request body.
 *  2. Attaches the JWT Bearer token when available.
 *  3. Normalises PIKNDEL error codes into thrown JS errors.
 *
 * @param {object} opts
 * @param {string}  opts.method   – HTTP verb (post | get | put …)
 * @param {string}  opts.path     – API path (e.g. /api/account/login)
 * @param {object}  [opts.data]   – Body payload (merged with Control)
 * @param {string|number} [opts.version] – Control.Version for this endpoint
 * @param {boolean} [opts.auth]   – Whether to attach Bearer token (default true)
 * @returns {Promise<object>} Normalised response data
 */
async function request({ method = "post", path, data = {}, version = 1, auth = true, wrapInData = false }) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (auth && cachedToken) {
    headers["Authorization"] = `Bearer ${cachedToken}`;
  }

  // Some endpoints (login) wrap payload in Data:{}, others spread fields at top level
  const body = wrapInData
    ? { Control: buildControl(version), Data: data }
    : { Control: buildControl(version), ...data };

  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${path}`,
      data: body,
      headers,
      timeout: 15000,
    });

    return handlePikndelResponse(response);
  } catch (err) {
    // axios network / timeout errors
    if (err.response) {
      return handlePikndelResponse(err.response);
    }
    throw new Error(`Network error calling PIKNDEL [${path}]: ${err.message}`);
  }
}

/**
 * Map PIKNDEL HTTP status codes to meaningful errors or resolved data.
 * @param {import('axios').AxiosResponse} response
 */
function handlePikndelResponse(response) {
  const { status, data } = response;

  switch (status) {
    case 200:
      return data; // ✅ Success

    case 400:
      throw Object.assign(
        new Error(`PIKNDEL Bad Request (400): ${data?.Message || JSON.stringify(data)}`),
        { statusCode: 400, pikndelData: data }
      );

    case 401:
      // Clear stale token
      cachedToken = null;
      throw Object.assign(
        new Error(`PIKNDEL Unauthorized (401): ${data?.Message || "Invalid or expired token."}`),
        { statusCode: 401, pikndelData: data }
      );

    case 500:
      throw Object.assign(
        new Error(`PIKNDEL Internal Server Error (500): ${data?.Message || JSON.stringify(data)}`),
        { statusCode: 500, pikndelData: data }
      );

    default:
      throw Object.assign(
        new Error(`PIKNDEL Unexpected Response (${status}): ${JSON.stringify(data)}`),
        { statusCode: status, pikndelData: data }
      );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Authentication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticate with the PIKNDEL API and cache the returned JWT token.
 *
 * @param {string} [username] – defaults to PIKNDEL_USERNAME env var
 * @param {string} [password] – defaults to PIKNDEL_PASSWORD env var
 * @returns {Promise<string>} JWT token
 */
async function login(username, password) {
  const Username = username || process.env.PIKNDEL_USERNAME;
  const Password = password || process.env.PIKNDEL_PASSWORD;

  if (!Username || !Password) {
    throw new Error("PIKNDEL credentials are missing. Set PIKNDEL_USERNAME and PIKNDEL_PASSWORD.");
  }

  const response = await request({
    path: "/backoffice/api/account/login",
    version: 1.3,
    auth: false,
    wrapInData: true,   // login uses Data:{} envelope
    data: {
      Username,
      Password,
      GrantType: "password",
    },
  });

  // PIKNDEL returns: { Control: {...}, Data: { Token: "...", UserId, Name, ... } }
  const token = response?.Data?.Token || response?.Token || response?.token || response?.access_token;
  if (!token) {
    throw new Error("Login succeeded but no JWT token was returned by PIKNDEL.");
  }

  cachedToken = token;
  const userId = response?.Data?.UserId || response?.UserId || null;
  console.log(`[PikndelService] Authentication successful. UserId=${userId}. Token cached.`);
  return { token, userId, name: response?.Data?.Name || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Place Order  (Version 3.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a new logistics order with PIKNDEL.
 *
 * Pass orderPayload matching this shape (mirrors PIKNDEL API v2.5):
 * {
 *   UserId: "800",
 *   OrderDetails: [{
 *     ClientUniqueNo: "MY-ORD-001",
 *     VehicleType: "Bike",      // Bike | Car
 *     TotalActualWeight: "1",
 *     EWAYBillNo: "",
 *     Info: [{
 *       Pickup:   { PersonName, Mobile, Address, Pincode, ... },
 *       Item:     [{ Qty, Type, IsFragile, IsLiquid, Cost, ActualWeight }],
 *       Delivery: { PersonName, Mobile, Address, Pincode, ... }
 *     }]
 *   }]
 * }
 *
 * @returns {Promise<object>} PIKNDEL confirmation (AWBNo, TrackingURL …)
 */
async function placeOrder(orderPayload) {
  const { UserId, OrderDetails } = orderPayload;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!UserId) throw new Error("placeOrder: UserId is required.");
  if (!Array.isArray(OrderDetails) || OrderDetails.length === 0) {
    throw new Error("placeOrder: OrderDetails must be a non-empty array.");
  }
  const od = OrderDetails[0];
  if (!od.ClientUniqueNo) throw new Error("placeOrder: OrderDetails[0].ClientUniqueNo is required.");
  if (!od.TotalActualWeight) throw new Error("placeOrder: OrderDetails[0].TotalActualWeight is required.");
  const infoEntry = Array.isArray(od.Info) ? od.Info[0] : od.Info;
  if (!infoEntry) throw new Error("placeOrder: OrderDetails[0].Info is required.");
  if (!infoEntry.Pickup) throw new Error("placeOrder: Info.Pickup is required.");
  if (!infoEntry.Delivery) throw new Error("placeOrder: Info.Delivery is required.");
  if (!Array.isArray(infoEntry.Item) || infoEntry.Item.length === 0) {
    throw new Error("placeOrder: Info.Item must be a non-empty array.");
  }

  // ── Build payload matching exact PIKNDEL v2.5 structure ───────────────────
  const body = {
    UserId: String(UserId),
    OrderDetails: OrderDetails.map((od) => {
      const inf = Array.isArray(od.Info) ? od.Info[0] : od.Info;
      return {
        PreAWBNo: od.PreAWBNo || "",
        ClientUniqueNo: od.ClientUniqueNo,
        VehicleType: od.VehicleType || "Bike",
        BrandName: od.BrandName || "",
        OrderType: od.OrderType || "B2C",
        InvoiceNo: od.InvoiceNo || "",
        InvoiceUrl: od.InvoiceUrl || "",
        InvoiceValue: od.InvoiceValue || "0.00",
        EWAYBillNo: od.EWAYBillNo || "",
        TotalActualWeight: String(od.TotalActualWeight),
        Info: [{
          Pickup: {
            UniqueNo: inf.Pickup.Mobile || "",
            PersonName: inf.Pickup.PersonName,
            Mobile: inf.Pickup.Mobile,
            AddressType: inf.Pickup.AddressType || "Home",
            HouseNo: inf.Pickup.HouseNo || "",
            Landmark: inf.Pickup.Landmark || "",
            Address: inf.Pickup.Address,
            Lat: inf.Pickup.Lat || "",
            Lng: inf.Pickup.Lng || "",
            Pincode: inf.Pickup.Pincode,
            CashPaid: inf.Pickup.CashPaid || "0",
            CashCollection: inf.Pickup.CashCollection || "0",
            Comment: inf.Pickup.Comment || "",
            PickupDate: inf.Pickup.PickupDate || "",
            PickupSlot: inf.Pickup.PickupSlot || "",
            RTOName: inf.Pickup.RTOName || inf.Pickup.PersonName,
            RTOMobile: inf.Pickup.RTOMobile || inf.Pickup.Mobile,
            RTOAddr: inf.Pickup.RTOAddr || inf.Pickup.Address,
            RTOPincode: inf.Pickup.RTOPincode || inf.Pickup.Pincode,
          },
          Item: inf.Item.map((item) => ({
            Qty: item.Qty,
            Type: item.Type || "Goods",
            IsFragile: String(item.IsFragile ?? "0"),
            IsLiquid: String(item.IsLiquid ?? "0"),
            Name: item.Name || null,
            Cost: item.Cost,
            Length: item.Length || 0,
            Width: item.Width || 0,
            Height: item.Height || 0,
            ActualWeight: item.ActualWeight || 1,
            EWayBillNo: item.EWayBillNo || item.EwayBillNo || "",   // capital W — confirmed from working Postman test
          })),
          Delivery: {
            UniqueNo: inf.Delivery.Mobile || "",
            PersonName: inf.Delivery.PersonName,
            Mobile: inf.Delivery.Mobile,
            AddressType: inf.Delivery.AddressType || "Home",
            HouseNo: inf.Delivery.HouseNo || "",
            Landmark: inf.Delivery.Landmark || "",
            Address: inf.Delivery.Address,
            Lat: inf.Delivery.Lat || "",
            Lng: inf.Delivery.Lng || "",
            Pincode: inf.Delivery.Pincode,
            CashCollection: parseFloat(inf.Delivery.CashCollection) || 0,  // number, not string
            Comment: inf.Delivery.Comment || "",
          },
        }],
      };
    }),
  };

  return request({
    path: "/backoffice/api/pikndel/place_order",
    version: 3.2,
    wrapInData: true,
    data: body,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Order Status (Pull)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch real-time activity/status for an existing order.
 *
 * @param {string} AWBNo – Airway Bill Number returned at order placement
 * @returns {Promise<object>} Status + activity details from PIKNDEL
 */
async function getOrderStatus(AWBNo) {
  if (!AWBNo) throw new Error("getOrderStatus: AWBNo is required.");

  return request({
    path: "/backoffice/api/pikndel/order/get_status",
    version: 1,
    wrapInData: true,
    data: { AWBNo },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  login,
  placeOrder,
  getOrderStatus,
  // Expose for testing / token refresh
  getToken: () => cachedToken,
  setToken: (t) => { cachedToken = t; },
};


/// coorect body to place an order
// {
//   "Control": {
//     "RequestId": "test-order-001",
//     "Source": "3",
//     "RequestTime": 1652350911,
//     "Version": "3.2"
//   },
//   "Data": {
//     "UserId": "7034",
//     "OrderDetails": [
//       {
//         "PreAWBNo": "",
//         "ClientUniqueNo": "LQ/TEST/3001",
//         "VehicleType": "Bike",
//         "BrandName": "TEST",
//         "OrderType": "B2C",
//         "InvoiceNo": "INV/3001",
//         "Invoice Url": "",
//         "Invoice Value": "55000.00",
//         "EWAYBillNo": "EWAY001TEST001",
//         "TotalActualWeight": "1",
//         "Info": [
//           {
//             "Pickup": {
//               "UniqueNo": "9876543210",
//               "PersonName": "Test Sender",
//               "Mobile": "9876543210",
//               "AddressType": "Home",
//               "HouseNo": "",
//               "Landmark": "",
//               "Address": "22, MG Road, Mumbai Central",
//               "Lat": "", 
//               "Lng": "", 
//               "Pincode": "400008",
//               "CashPaid": "0",
//               "CashCollection": "0",
//               "Comment": "",
//               "PickupDate": "",
//               "PickupSlot": "",
//               "RTOName": "Test Sender",
//               "RTOMobile": "9876543210",
//               "RTOAddr": "22, MG Road Mumbai",
//               "RTOPincode": "400008"
//             },
//             "Item": [
//               {
//                 "Qty": 1,
//                 "Type": "Goods",
//                 "IsFragile": "0",
//                 "IsLiquid": "0",
//                 "Name": "Test Item",
//                 "Cost": 55000,
//                 "Length": 10,
//                 "Width": 10,
//                 "Height": 10,
//                 "ActualWeight": 1,
//                 "EWayBillNo": ""
//               }
//             ],
//             "Delivery": {
//               "UniqueNo": "9123456789",
//               "PersonName": "Test Receiver",
//               "Mobile": "9123456789",
//               "AddressType": "Office",
//               "HouseNo": "",
//               "Landmark": "",
//               "Address": "Govindpuri Kalkaji, New Delhi",
//               "Lat": "", 
//               "Lng": "", 
//               "Pincode": "110019",
//               "CashCollection": 0,
//               "Comment": ""
//             }
//           }
//         ]
//       }
//     ]
//   }
// }