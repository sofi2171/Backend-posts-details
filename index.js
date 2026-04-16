const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// CORS aur JSON parsing setup
app.use(cors({ origin: true }));
app.use(express.json());

// 🔥 FIREBASE ADMIN INITIALIZATION (Error-Free Version) 🔥
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                // Vercel Environment Variables se data uthayega
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Private Key ki newlines aur quotes ko yahan fix kiya gaya hai
                privateKey: process.env.FIREBASE_PRIVATE_KEY 
                    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '').trim() 
                    : undefined,
            }),
            databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
        });
        console.log("✅ Firebase Admin Initialized Successfully!");
    } catch (initError) {
        console.error("❌ Firebase Initialization Error:", initError.message);
    }
}

const db = admin.firestore();
const dbRT = admin.database();

// --- Default Route (Sirf check karne ke liye ke server zinda hai) ---
app.get('/', (req, res) => {
    res.status(200).send("Health Jobs Sync Server is Running!");
});

// ==========================================
// 🚀 ROUTE: UPDATE POST & TRIGGER FAST SYNC
// ==========================================
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData } = req.body;

        if (!postId || !updatedData) {
            return res.status(400).json({ success: false, error: "Post ID aur Updated Data missing hai!" });
        }

        // 1. FIRESTORE UPDATE
        await db.collection('posts').doc(postId).update({
            ...updatedData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. REALTIME DATABASE SYNC SIGNAL
        // Is se sab users ki local storage auto-clear hogi
        await dbRT.ref('global_sync').set({
            lastUpdate: Date.now(),
            target: 'trending_cache',
            updatedPostId: postId
        });

        console.log(`✅ Post ${postId} updated and sync triggered.`);
        res.status(200).json({ success: true, message: "Post successfully updated and synced!" });

    } catch (error) {
        console.error("❌ Update Route Error:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Vercel ke liye export zaroori hai
module.exports = app;
