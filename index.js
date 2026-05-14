const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

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

const db   = admin.firestore();
const dbRT = admin.database();

// ============================================
// ☁️ CLOUDINARY MEDIA DELETE HELPER
// ============================================
async function deleteFromCloudinary(publicId, resourceType = 'image') {
    try {
        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey    = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret) {
            console.warn('⚠️ Cloudinary env vars missing — skipping delete');
            return false;
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const strToSign = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature = crypto.createHash('sha1').update(strToSign).digest('hex');

        const formData  = new URLSearchParams();
        formData.append('public_id', publicId);
        formData.append('timestamp', timestamp);
        formData.append('api_key',   apiKey);
        formData.append('signature', signature);

        const url      = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`;
        const response = await fetch(url, { method: 'POST', body: formData });
        const result   = await response.json();

        console.log(`☁️ Cloudinary delete [${resourceType}] ${publicId}:`, result.result);
        return result.result === 'ok';

    } catch (err) {
        console.error('☁️ Cloudinary delete error:', err.message);
        return false;
    }
}

// Cloudinary URL se public_id aur resource_type nikalta hai
function parseCloudinaryUrl(url) {
    try {
        const match     = url.match(/\/(?:image|video|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
        const typeMatch = url.match(/\/(image|video|raw)\/upload\//);
        if (!match || !typeMatch) return null;
        return { publicId: match[1], resourceType: typeMatch[1] };
    } catch {
        return null;
    }
}

// Post ki saari media Cloudinary se delete karta hai
async function deletePostMediaFromCloudinary(mediaArray) {
    if (!mediaArray || !Array.isArray(mediaArray) || mediaArray.length === 0) return;
    for (const mediaItem of mediaArray) {
        const url = mediaItem.url || mediaItem;
        if (!url || typeof url !== 'string') continue;
        const parsed = parseCloudinaryUrl(url);
        if (!parsed) { console.warn('⚠️ Could not parse Cloudinary URL:', url); continue; }
        await deleteFromCloudinary(parsed.publicId, parsed.resourceType);
    }
}

// ============================================
// 🚀 POST UPDATE ROUTE
// POST /api/update-post
// ============================================
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData, expiresAt } = req.body;

        if (!postId) {
            return res.status(400).json({ success: false, error: 'postId required' });
        }

        const updateObj = {
            lastSyncUpdate: admin.firestore.FieldValue.serverTimestamp()
        };

        if (expiresAt) updateObj.expiresAt = expiresAt;

        if (updatedData && typeof updatedData === 'object') {
            Object.assign(updateObj, updatedData);
        }

        await db.collection('posts').doc(postId).update(updateObj);

        if (updatedData && (updatedData.status === 'inactive' || updatedData.status === 'deleted')) {
            await dbRT.ref(`search_index/${postId}`).remove();
            console.log(`🗑️ Post ${postId} removed from Search Index.`);
        }

        await dbRT.ref('global_sync').set({
            lastUpdate:    Date.now(),
            target:        'all_caches',
            updatedPostId: postId,
            action:        (updatedData && updatedData.status) || 'update'
        });

        res.status(200).json({ success: true, message: 'Updated successfully!' });

    } catch (error) {
        console.error('Update Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 🗑️ POST DELETE + CLOUDINARY CLEANUP
// DELETE /api/delete-post
// Body: { postId: "abc123" }
// ============================================
app.delete('/api/delete-post', async (req, res) => {
    try {
        const { postId } = req.body;

        if (!postId) {
            return res.status(400).json({ success: false, error: 'postId required' });
        }

        const postDoc = await db.collection('posts').doc(postId).get();

        if (!postDoc.exists) {
            return res.status(404).json({ success: false, error: 'Post not found' });
        }

        const postData = postDoc.data();

        // ☁️ Cloudinary se media delete
        if (postData.media && postData.media.length > 0) {
            console.log(`☁️ Deleting ${postData.media.length} media file(s) from Cloudinary...`);
            await deletePostMediaFromCloudinary(postData.media);
        }

        // Firestore se delete
        await db.collection('posts').doc(postId).delete();
        console.log(`✅ Post ${postId} deleted from Firestore.`);

        // RTDB Search Index se hatao
        await dbRT.ref(`search_index/${postId}`).remove();

        // Global Sync
        await dbRT.ref('global_sync').set({
            lastUpdate:    Date.now(),
            target:        'all_caches',
            updatedPostId: postId,
            action:        'deleted'
        });

        res.status(200).json({ success: true, message: 'Post and media deleted successfully!' });

    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 🔍 DEBUG — Expired Posts Check (Delete nahi karta)
// GET /api/debug-expired
// ============================================
app.get('/api/debug-expired', async (req, res) => {
    try {
        const now = new Date();

        const snapshot = await db.collection('posts').get();

        const results = [];
        snapshot.docs.forEach(docSnap => {
            const post = docSnap.data();
            if (post.expiresAt) {

                // Date parse — Timestamp ya string dono
                let expiryDate;
                if (typeof post.expiresAt.toDate === 'function') {
                    expiryDate = post.expiresAt.toDate();
                } else {
                    expiryDate = new Date(post.expiresAt);
                }

                results.push({
                    id:                    docSnap.id,
                    title:                 post.title || 'No title',
                    expiresAt:             post.expiresAt,
                    expiresAt_type:        typeof post.expiresAt,
                    isExpired:             post.isExpired,
                    isExpiredField_exists: post.isExpired !== undefined,
                    alreadyPast:           expiryDate <= now,
                    expiryDate_parsed:     expiryDate.toISOString()
                });
            }
        });

        res.json({
            now:               now.toISOString(),
            total_with_expiry: results.length,
            posts:             results
        });

    } catch (err) {
        console.error('Debug Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// 🕐 AUTO EXPIRY DELETE (Cron — har ghante)
// GET /api/cleanup-expired
// ============================================
app.get('/api/cleanup-expired', async (req, res) => {
    try {
        const now = new Date();

        // Saari posts fetch karo
        // String aur Timestamp dono formats handle karne ke liye
        const snapshot = await db.collection('posts').get();

        if (snapshot.empty) {
            return res.json({ success: true, message: 'No posts found.', deleted: 0 });
        }

        let deleted = 0;
        let skipped = 0;

        for (const docSnap of snapshot.docs) {
            const post   = docSnap.data();
            const postId = docSnap.id;

            // expiresAt nahi — skip
            if (!post.expiresAt) { skipped++; continue; }

            // Already expired mark — skip
            if (post.isExpired === true) { skipped++; continue; }

            // Date parse — Firestore Timestamp ya ISO string dono
            let expiryDate;
            if (typeof post.expiresAt.toDate === 'function') {
                expiryDate = post.expiresAt.toDate();
            } else {
                expiryDate = new Date(post.expiresAt);
            }

            // Invalid date — skip
            if (isNaN(expiryDate.getTime())) { skipped++; continue; }

            // Abhi tak expire nahi hua — skip
            if (now < expiryDate) { skipped++; continue; }

            // ✅ Expire ho gaya — delete karo
            try {
                // ☁️ Cloudinary se media delete
                if (post.media && post.media.length > 0) {
                    console.log(`☁️ Deleting media for expired post ${postId}...`);
                    await deletePostMediaFromCloudinary(post.media);
                }

                // Firestore se delete
                await db.collection('posts').doc(postId).delete();

                // RTDB Search Index se hatao
                await dbRT.ref('search_index/' + postId).remove();

                // Global Sync Signal
                await dbRT.ref('global_sync').set({
                    lastUpdate:    Date.now(),
                    target:        'all_caches',
                    updatedPostId: postId,
                    action:        'expired_deleted'
                });

                console.log(`✅ Expired post deleted: ${postId}`);
                deleted++;

            } catch (deleteErr) {
                console.error(`❌ Failed to delete post ${postId}:`, deleteErr.message);
            }
        }

        console.log(`Cleanup done — deleted: ${deleted}, skipped: ${skipped}`);
        return res.json({
            success: true,
            deleted,
            skipped,
            message: `${deleted} expired post(s) deleted.`
        });

    } catch (err) {
        console.error('Cleanup Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================
// ✅ HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
    res.json({
        status:    'ok',
        service:   'Health Jobs — Posts Backend',
        version:   '3.0.0',
        endpoints: [
            'POST   /api/update-post',
            'DELETE /api/delete-post',
            'GET    /api/cleanup-expired',
            'GET    /api/debug-expired'
        ]
    });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => console.log('Server: http://localhost:' + PORT));
}
