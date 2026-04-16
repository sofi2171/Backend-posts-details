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

// 🚀 FAST UPDATE, SEARCH CLEANUP & SYNC ROUTE
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData } = req.body;

        // 1. Firestore Update (Post ka status ya data badlein)
        await db.collection('posts').doc(postId).update({
            ...updatedData,
            lastSyncUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

        // 🔥 2. SEARCH INDEX CLEANUP (Realtime Database)
        // Agar post inactive ya delete ho rahi hai, toh search entry foran urra do
        if (updatedData.status === 'inactive' || updatedData.status === 'deleted') {
            await dbRT.ref(`search_index/${postId}`).remove();
            console.log(`Post ${postId} removed from Search Index.`);
        }

        // ⚡ 3. GLOBAL SYNC SIGNAL (Home Page refresh ke liye)
        await dbRT.ref('global_sync').set({
            lastUpdate: Date.now(),
            target: 'all_caches',
            updatedPostId: postId,
            action: updatedData.status || 'update'
        });

        res.status(200).json({ success: true, message: "Updated and Search Index cleaned!" });
    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
