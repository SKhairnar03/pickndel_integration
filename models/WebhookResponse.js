const mongoose = require("mongoose");

const webhookSchema = new mongoose.Schema(
    {
        AWBNo: { type: String, required: false },
        short_code: { type: String, required: false },
        activity: { type: String, required: false },
        timestamp: { type: Number, required: false },
        rawPayload: { type: mongoose.Schema.Types.Mixed }, // Stores the entire JSON object sent by PIKNDEL
    },
    {
        timestamps: true, // Automatically manages createdAt and updatedAt
        collection: "pickndel integration responce file", // Specific collection name requested
    }
);

module.exports = mongoose.model("WebhookResponse", webhookSchema);
