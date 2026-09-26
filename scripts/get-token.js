const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Setup Firebase Admin
if (admin.apps.length === 0) {
    if (process.env.FB_SERVICE_KEY) {
        try {
            const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf-8");
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(decoded))
            });
        } catch (e) {
            console.error("Failed to parse FB_SERVICE_KEY:", e.message);
        }
    } else {
        const keyPath = path.join(__dirname, "../firebase-service-keys.json");
        if (fs.existsSync(keyPath)) {
            const serviceAccount = require(keyPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
    }
}

// Find Firebase Web API key
let apiKey = process.env.FIREBASE_WEB_API_KEY;
if (!apiKey) {
    const clientEnvPath = path.join(__dirname, "../../miami-beach-resort/.env");
    if (fs.existsSync(clientEnvPath)) {
        const clientEnv = fs.readFileSync(clientEnvPath, "utf-8");
        const match = clientEnv.match(/VITE_FIREBASE_API_KEY=(.*)/);
        if (match) apiKey = match[1].trim();
    }
}
if (!apiKey) {
    apiKey = "AIzaSyAKHCbY2N6GN22uZ5SPeYnNFc6KstqKFcI";
}

async function generateToken(targetEmail = "leonsikhder@gmail.com") {
    try {
        const user = await admin.auth().getUserByEmail(targetEmail);
        const customToken = await admin.auth().createCustomToken(user.uid);

        const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: customToken, returnSecureToken: true })
        });

        const data = await response.json();
        if (data.idToken) {
            console.log("\n========================================================");
            console.log(`Generated Bearer Token for: ${targetEmail} (Admin)`);
            console.log("Expires in: 1 hour (3600 seconds)");
            console.log("========================================================\n");
            console.log(data.idToken);
            console.log("\n========================================================\n");
        } else {
            console.error("Failed to exchange custom token:", data);
        }
    } catch (err) {
        console.error("Error generating token:", err.message);
    }
}

const emailArg = process.argv[2] || "leonsikhder@gmail.com";
generateToken(emailArg);
