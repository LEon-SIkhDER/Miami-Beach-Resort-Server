const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

async function run() {
    try {
        if (admin.apps.length === 0) {
            const keyPath = path.join(__dirname, "../firebase-service-keys.json");
            if (fs.existsSync(keyPath)) {
                admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
            } else if (process.env.FB_SERVICE_KEY) {
                const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
                admin.initializeApp({ credential: admin.credential.cert(JSON.parse(decoded)) });
            }
        }
        
        console.log("Getting token for leonsikhder@gmail.com ...");
        const user = await admin.auth().getUserByEmail("leonsikhder@gmail.com");
        const customToken = await admin.auth().createCustomToken(user.uid);
        const apiKey = "AIzaSyAKHCbY2N6GN22uZ5SPeYnNFc6KstqKFcI";
        const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
        });
        const authData = await authRes.json();
        const token = authData.idToken;

        console.log("Token acquired. Testing https://api-miami-beach-resort.vercel.app/admin/overview ...");
        
        // 1. Test without token (Unauthorized test)
        console.log("\n--- Test 1: No Authorization Header ---");
        const resNoAuth = await fetch("https://api-miami-beach-resort.vercel.app/admin/overview");
        console.log(`Status: ${resNoAuth.status} ${resNoAuth.statusText}`);
        console.log(`Body:`, await resNoAuth.text());

        // 2. Test with invalid token
        console.log("\n--- Test 2: Invalid Bearer Token ---");
        const resBadAuth = await fetch("https://api-miami-beach-resort.vercel.app/admin/overview", {
            headers: { Authorization: "Bearer bad_token_123" }
        });
        console.log(`Status: ${resBadAuth.status} ${resBadAuth.statusText}`);
        console.log(`Body:`, await resBadAuth.text());

        // 3. Test with valid admin token
        console.log("\n--- Test 3: Valid Admin Bearer Token ---");
        const t0 = performance.now();
        const resValid = await fetch("https://api-miami-beach-resort.vercel.app/admin/overview", {
            headers: { Authorization: `Bearer ${token}` }
        });
        const t1 = performance.now();
        console.log(`Status: ${resValid.status} ${resValid.statusText}`);
        console.log(`Response Time: ${(t1 - t0).toFixed(0)} ms`);
        
        const bodyText = await resValid.text();
        try {
            const data = JSON.parse(bodyText);
            console.log("Response JSON Structure:");
            console.log(JSON.stringify(data, null, 2));

            // Validate data fields
            console.log("\n--- Validation of Fields ---");
            const expectedKeys = [
                "totalBookings",
                "confirmedCount",
                "pendingCount",
                "cancelledCount",
                "totalRevenue",
                "monthlyRevenue",
                "currentMonthName",
                "bookingsPerDay",
                "bookingsPerRoom",
                "revenuePerRoom"
            ];
            const missingKeys = expectedKeys.filter(k => !(k in data));
            if (missingKeys.length === 0) {
                console.log(" All expected fields are present!");
            } else {
                console.log("❌ Missing fields:", missingKeys);
            }

            console.log("\nMetrics Summary:");
            console.log(`- Total Bookings: ${data.totalBookings}`);
            console.log(`- Confirmed Count: ${data.confirmedCount}`);
            console.log(`- Pending Count: ${data.pendingCount}`);
            console.log(`- Cancelled Count: ${data.cancelledCount}`);
            console.log(`- Total Revenue: $${data.totalRevenue}`);
            console.log(`- Monthly Revenue (${data.currentMonthName}): $${data.monthlyRevenue}`);
            console.log(`- Bookings Per Day entries: ${data.bookingsPerDay?.length || 0}`);
            console.log(`- Room Categories: ${data.bookingsPerRoom?.length || 0}`);

            console.log("\n--- Latency Benchmark (3 consecutive warm requests) ---");
            for (let i = 1; i <= 3; i++) {
                const start = performance.now();
                const bRes = await fetch("https://api-miami-beach-resort.vercel.app/admin/overview", {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const ms = (performance.now() - start).toFixed(0);
                console.log(`Request #${i}: status ${bRes.status} in ${ms}ms`);
            }
        } catch (e) {
            console.error("Non-JSON Response received:", bodyText);
        }

    } catch (err) {
        console.error("Test execution error:", err);
    }
}

run();
