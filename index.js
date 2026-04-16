const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// Firebase Admin Init
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '').trim() : undefined,
        }),
        databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
    });
}

const db = admin.firestore();
const dbRT = admin.database();

// 🚀 FAST UPDATE & SYNC ROUTE
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData } = req.body;

        // 1. Firestore Update
        await db.collection('posts').doc(postId).update({
            ...updatedData,
            lastSyncUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. GLOBAL SYNC SIGNAL (For Home Page)
        // Ye poori app ko batayega ke data badal gaya hai
        await dbRT.ref('global_sync').set({
            lastUpdate: Date.now(),
            target: 'trending_cache',
            updatedPostId: postId
        });

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
