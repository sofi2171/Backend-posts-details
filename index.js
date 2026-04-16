const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// CORS allow karega taake aapki app se requests block na hon
app.use(cors({ origin: true }));
app.use(express.json());

// 🔥 Firebase Admin Setup (Vercel Environment Variables se) 🔥
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Vercel mein private key ki new lines ko fix karne ke liye replace use hota hai
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        }),
        databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com" // Aapka DB URL
    });
}

const db = admin.firestore();
const dbRT = admin.database();

// ==========================================
// 🚀 ROUTE: UPDATE POST & TRIGGER FAST SYNC
// ==========================================
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData } = req.body;

        if (!postId || !updatedData) {
            return res.status(400).json({ error: "Post ID aur Updated Data zaroori hai!" });
        }

        // 1. FIRESTORE UPDATE (Post ko update karna)
        await db.collection('posts').doc(postId).update({
            ...updatedData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp() // Akhri update ka time
        });

        // 2. REALTIME DATABASE SYNC (Sab mobiles ko signal bhejna)
        // Ye line poori app mein sabki local storage clean karwayegi
        await dbRT.ref('global_sync').set({
            lastUpdate: Date.now(),
            target: 'trending_cache',
            updatedPostId: postId
        });

        res.status(200).json({ success: true, message: "Post 100% update aur sync ho gayi!" });
    } catch (error) {
        console.error("Update Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Vercel Serverless Functions ke liye export zaroori hai
module.exports = app;
