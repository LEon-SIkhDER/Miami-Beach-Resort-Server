const { MongoClient } = require("mongodb");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.7hhwads.mongodb.net/?appName=Cluster0`;

async function debug() {
    const client = new MongoClient(uri);
    await client.connect();
    console.log("✅ Connected to MongoDB\n");

    const db = client.db("miami_beach_resort_db");
    const col = db.collection("bookings");

    // Check sample doc structure
    const sample = await col.findOne({});
    console.log("Sample doc keys:", Object.keys(sample || {}));
    console.log("Has rooms array:", Array.isArray(sample?.rooms));
    console.log("Sample rooms[0]:", sample?.rooms?.[0]);
    console.log("Sample status:", sample?.status);
    console.log("Sample createdAt:", sample?.createdAt, typeof sample?.createdAt);
    console.log("");

    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const CONFIRMED = ["booking_confirmed", "checked_id", "checked_in", "checked_out", "confirmed"];
    const CANCELLED = ["cancel", "cancelled"];

    // Test each facet branch individually to find which one errors
    console.log("Testing statusCounts facet...");
    try {
        const r = await col.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).toArray();
        console.log("✅ statusCounts OK:", r);
    } catch(e) { console.error("❌ statusCounts error:", e.message); }

    console.log("\nTesting bookingsPerDay facet...");
    try {
        const r = await col.aggregate([
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
            { $sort: { _id: -1 } },
            { $limit: 7 },
            { $sort: { _id: 1 } }
        ]).toArray();
        console.log("✅ bookingsPerDay OK:", r);
    } catch(e) { console.error("❌ bookingsPerDay error:", e.message); }

    console.log("\nTesting totalRevenue facet...");
    try {
        const r = await col.aggregate([
            { $match: { $or: [{ status: { $in: CONFIRMED } }, { status: { $in: CANCELLED }, paidAmount: { $gt: 0 } }] } },
            {
                $project: {
                    status: 1,
                    paidAmount: { $ifNull: ["$paidAmount", 0] },
                    discountAmount: { $ifNull: ["$discountAmount", { $ifNull: ["$discount", 0] }] },
                    extraServiceCost: { $ifNull: ["$extraServiceCost", 0] },
                    roomSubtotal: {
                        $cond: [
                            { $and: [{ $isArray: "$rooms" }, { $gt: [{ $size: { $ifNull: ["$rooms", []] } }, 0] }] },
                            { $reduce: { input: "$rooms", initialValue: 0, in: { $add: ["$$value", { $multiply: [{ $ifNull: ["$$this.pricePerNight", 0] }, { $max: [{ $ifNull: ["$$this.nights", 0] }, 0] }] }] } } },
                            { $multiply: [{ $ifNull: ["$pricePerNight", 0] }, { $max: [{ $ifNull: ["$nights", 0] }, 0] }] }
                        ]
                    }
                }
            },
            { $project: { revenue: { $cond: [{ $in: ["$status", CANCELLED] }, "$paidAmount", { $max: [{ $subtract: [{ $add: ["$roomSubtotal", "$extraServiceCost"] }, "$discountAmount"] }, 0] }] } } },
            { $group: { _id: null, total: { $sum: "$revenue" } } }
        ]).toArray();
        console.log("✅ totalRevenue OK:", r);
    } catch(e) { console.error("❌ totalRevenue error:", e.message); }

    console.log("\nTesting monthlyRevenue facet...");
    try {
        const r = await col.aggregate([
            {
                $match: {
                    $and: [
                        { $or: [{ status: { $in: CONFIRMED } }, { status: { $in: CANCELLED }, paidAmount: { $gt: 0 } }] },
                        { $or: [{ createdAt: { $gte: currentMonthStart, $lte: currentMonthEnd } }, { cancelledAt: { $gte: currentMonthStart, $lte: currentMonthEnd } }] }
                    ]
                }
            },
            {
                $project: {
                    status: 1,
                    paidAmount: { $ifNull: ["$paidAmount", 0] },
                    discountAmount: { $ifNull: ["$discountAmount", { $ifNull: ["$discount", 0] }] },
                    extraServiceCost: { $ifNull: ["$extraServiceCost", 0] },
                    roomSubtotal: {
                        $cond: [
                            { $and: [{ $isArray: "$rooms" }, { $gt: [{ $size: { $ifNull: ["$rooms", []] } }, 0] }] },
                            { $reduce: { input: "$rooms", initialValue: 0, in: { $add: ["$$value", { $multiply: [{ $ifNull: ["$$this.pricePerNight", 0] }, { $max: [{ $ifNull: ["$$this.nights", 0] }, 0] }] }] } } },
                            { $multiply: [{ $ifNull: ["$pricePerNight", 0] }, { $max: [{ $ifNull: ["$nights", 0] }, 0] }] }
                        ]
                    }
                }
            },
            { $project: { revenue: { $cond: [{ $in: ["$status", CANCELLED] }, "$paidAmount", { $max: [{ $subtract: [{ $add: ["$roomSubtotal", "$extraServiceCost"] }, "$discountAmount"] }, 0] }] } } },
            { $group: { _id: null, total: { $sum: "$revenue" } } }
        ]).toArray();
        console.log("✅ monthlyRevenue OK:", r);
    } catch(e) { console.error("❌ monthlyRevenue error:", e.message); }

    console.log("\nTesting bookingsPerRoom facet...");
    try {
        const r = await col.aggregate([
            { $match: { status: { $in: CONFIRMED } } },
            { $unwind: { path: "$rooms", preserveNullAndEmpty: false } },
            { $group: { _id: { $trim: { input: { $ifNull: ["$rooms.categoryName", { $ifNull: ["$roomName", { $ifNull: ["$roomCategory", "Room"] }] }] } } }, count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]).toArray();
        console.log("✅ bookingsPerRoom OK:", r);
    } catch(e) { console.error("❌ bookingsPerRoom error:", e.message); }

    console.log("\nTesting revenuePerRoom facet...");
    try {
        const r = await col.aggregate([
            { $match: { $or: [{ status: { $in: CONFIRMED } }, { status: { $in: CANCELLED }, paidAmount: { $gt: 0 } }] } },
            { $unwind: { path: "$rooms", preserveNullAndEmpty: true } },
            {
                $group: {
                    _id: { $trim: { input: { $ifNull: ["$rooms.categoryName", { $ifNull: ["$roomName", { $ifNull: ["$roomCategory", "Room"] }] }] } } },
                    revenue: { $sum: { $cond: [{ $in: ["$status", CANCELLED] }, { $ifNull: ["$paidAmount", 0] }, { $max: [{ $multiply: [{ $ifNull: ["$rooms.pricePerNight", 0] }, { $max: [{ $ifNull: ["$rooms.nights", 0] }, 0] }] }, 0] }] } }
                }
            },
            { $sort: { revenue: -1 } }
        ]).toArray();
        console.log("✅ revenuePerRoom OK:", r);
    } catch(e) { console.error("❌ revenuePerRoom error:", e.message); }

    await client.close();
}

debug().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
