const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

if (admin.apps.length === 0) {
    if (process.env.FB_SERVICE_KEY) {
        try {
            const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
            admin.initializeApp({ credential: admin.credential.cert(JSON.parse(decoded)) });
        } catch (e) {
            console.error("Firebase init error:", e.message);
            process.exit(1);
        }
    }
}

let apiKey = process.env.FIREBASE_WEB_API_KEY;
if (!apiKey) {
    const clientEnvPath = path.join(__dirname, "../../miami-beach-resort/.env");
    if (fs.existsSync(clientEnvPath)) {
        const clientEnv = fs.readFileSync(clientEnvPath, "utf-8");
        const match = clientEnv.match(/VITE_FIREBASE_API_KEY=(.*)/);
        if (match) apiKey = match[1].trim();
    }
}
if (!apiKey) apiKey = "AIzaSyAKHCbY2N6GN22uZ5SPeYnNFc6KstqKFcI";

const TARGET_EMAIL = process.argv[2] || "leonsikhder@gmail.com";
const API_URL = "https://api-miami-beach-resort.vercel.app/admin/overview";

async function testOverview() {
    console.log(`\n🔐 Getting token for: ${TARGET_EMAIL}`);
    const user = await admin.auth().getUserByEmail(TARGET_EMAIL);
    const customToken = await admin.auth().createCustomToken(user.uid);

    const tokenRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true })
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.idToken) {
        console.error("❌ Failed to get token:", tokenData);
        process.exit(1);
    }
    console.log("✅ Token obtained. Calling /admin/overview...\n");

    const start = Date.now();
    const res = await fetch(API_URL, {
        headers: { Authorization: `Bearer ${tokenData.idToken}` }
    });
    const elapsed = Date.now() - start;

    if (!res.ok) {
        const text = await res.text();
        console.error(`❌ HTTP ${res.status}: ${text}`);
        process.exit(1);
    }

    const data = await res.json();

    console.log(`✅ Response received in ${elapsed}ms (HTTP ${res.status})\n`);
    console.log("📊 Response shape:");
    console.log("  totalBookings:   ", data.totalBookings);
    console.log("  confirmedCount:  ", data.confirmedCount);
    console.log("  pendingCount:    ", data.pendingCount);
    console.log("  cancelledCount:  ", data.cancelledCount);
    console.log("  totalRevenue:    ", data.totalRevenue);
    console.log("  monthlyRevenue:  ", data.monthlyRevenue);
    console.log("  currentMonthName:", data.currentMonthName);
    console.log("  bookingsPerDay:  ", JSON.stringify(data.bookingsPerDay));
    console.log("  bookingsPerRoom: ", JSON.stringify(data.bookingsPerRoom?.slice(0, 3)));
    console.log("  revenuePerRoom:  ", JSON.stringify(data.revenuePerRoom?.slice(0, 3)));

    const missing = ["totalBookings","confirmedCount","pendingCount","cancelledCount","totalRevenue","monthlyRevenue","currentMonthName","bookingsPerDay","bookingsPerRoom","revenuePerRoom"]
        .filter(k => data[k] === undefined);

    if (missing.length) {
        console.error("\n⚠️  Missing fields:", missing);
    } else {
        console.log("\n✅ All required fields present!");
    }
}

testOverview().catch(err => {
    console.error("❌ Test failed:", err.message);
    process.exit(1);
});
