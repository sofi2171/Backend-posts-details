const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ============================================
// 🔥 FIREBASE ADMIN INIT
// ============================================
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY
                ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/"/g, '').trim()
                : undefined,
        }),
        databaseURL: "https://jobs-45cc9-default-rtdb.firebaseio.com"
    });
}

const db = admin.firestore();
const dbRT = admin.database();

// ============================================
// 🚀 POST UPDATE, SEARCH CLEANUP & SYNC ROUTE
// ============================================
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData } = req.body;

        // 1. Firestore Update
        await db.collection('posts').doc(postId).update({
            ...updatedData,
            lastSyncUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

        // 2. Search Index Cleanup — agar post inactive ya deleted ho
        if (updatedData.status === 'inactive' || updatedData.status === 'deleted') {
            await dbRT.ref(`search_index/${postId}`).remove();
            console.log(`Post ${postId} removed from Search Index.`);
        }

        // 3. Global Sync Signal
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

// ============================================
// 🕐 AUTO EXPIRY DELETE (Cron — ہر گھنٹے چلے گا)
// ============================================
app.get('/api/cleanup-expired', async (req, res) => {
    try {
        const now = new Date();
        const nowISO = now.toISOString();

        // وہ posts جن کی expiresAt گزر چکی ہو
        const snapshot = await db.collection('posts')
            .where('expiresAt', '<=', nowISO)
            .where('isExpired', '==', false)
            .get();

        if (snapshot.empty) {
            return res.json({ success: true, message: "No expired posts found.", deleted: 0 });
        }

        let deleted = 0;

        for (const docSnap of snapshot.docs) {
            const post = docSnap.data();
            const expiry = new Date(post.expiresAt);

            if (now >= expiry) {
                // Firestore سے delete
                await db.collection('posts').doc(docSnap.id).delete();

                // RTDB Search Index سے بھی ہٹاؤ
                await dbRT.ref('search_index/' + docSnap.id).remove();

                // Global Sync Signal
                await dbRT.ref('global_sync').set({
                    lastUpdate: Date.now(),
                    target: 'all_caches',
                    updatedPostId: docSnap.id,
                    action: 'expired_deleted'
                });

                console.log(`✅ Expired post deleted: ${docSnap.id}`);
                deleted++;
            }
        }

        return res.json({ success: true, deleted, message: `${deleted} expired post(s) deleted.` });

    } catch (err) {
        console.error("Cleanup Error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = app;
