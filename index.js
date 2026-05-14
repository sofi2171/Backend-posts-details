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

const db = admin.firestore();
const dbRT = admin.database();

// ============================================
// ☁️ CLOUDINARY MEDIA DELETE HELPER
// Cloudinary REST API se file delete karta hai
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

        const timestamp  = Math.floor(Date.now() / 1000);
        const strToSign  = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
        const signature  = crypto.createHash('sha1').update(strToSign).digest('hex');

        const formData   = new URLSearchParams();
        formData.append('public_id',    publicId);
        formData.append('timestamp',    timestamp);
        formData.append('api_key',      apiKey);
        formData.append('signature',    signature);

        const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`;

        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
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
        // Example URL:
        // https://res.cloudinary.com/Dr06qkbaa/image/upload/v123/post_uid_123.jpg
        // https://res.cloudinary.com/Dr06qkbaa/video/upload/v123/post_uid_123.mp4
        // https://res.cloudinary.com/Dr06qkbaa/raw/upload/v123/secure_doc.txt

        const match = url.match(/\/(?:image|video|raw)\/upload\/(?:v\d+\/)?(.+?)(?:\.[^.]+)?$/);
        const typeMatch = url.match(/\/(image|video|raw)\/upload\//);

        if (!match || !typeMatch) return null;

        const publicId     = match[1];
        const resourceType = typeMatch[1]; // image | video | raw

        return { publicId, resourceType };
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
        if (!parsed) {
            console.warn('⚠️ Could not parse Cloudinary URL:', url);
            continue;
        }

        await deleteFromCloudinary(parsed.publicId, parsed.resourceType);
    }
}

// ============================================
// 🚀 POST UPDATE, SEARCH CLEANUP & SYNC ROUTE
// ============================================
app.post('/api/update-post', async (req, res) => {
    try {
        const { postId, updatedData, expiresAt } = req.body;

        if (!postId) {
            return res.status(400).json({ success: false, error: 'postId required' });
        }

        // Build update object
        const updateObj = {
            lastSyncUpdate: admin.firestore.FieldValue.serverTimestamp()
        };

        // Frontend se expiresAt aaya ho toh save karo
        if (expiresAt) {
            updateObj.expiresAt = expiresAt;
        }

        // updatedData object aaya ho toh merge karo
        if (updatedData && typeof updatedData === 'object') {
            Object.assign(updateObj, updatedData);
        }

        // 1. Firestore Update
        await db.collection('posts').doc(postId).update(updateObj);

        // 2. Agar status inactive ya deleted ho — search index hatao
        if (updatedData && (updatedData.status === 'inactive' || updatedData.status === 'deleted')) {
            await dbRT.ref(`search_index/${postId}`).remove();
            console.log(`🗑️ Post ${postId} removed from Search Index.`);
        }

        // 3. Global Sync Signal
        await dbRT.ref('global_sync').set({
            lastUpdate:    Date.now(),
            target:        'all_caches',
            updatedPostId: postId,
            action:        (updatedData && updatedData.status) || 'update'
        });

        res.status(200).json({ success: true, message: 'Updated and Search Index cleaned!' });

    } catch (error) {
        console.error('Backend Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 🗑️ POST DELETE + CLOUDINARY MEDIA CLEANUP
// DELETE /api/delete-post
// Body: { postId: "abc123" }
// ============================================
app.delete('/api/delete-post', async (req, res) => {
    try {
        const { postId } = req.body;

        if (!postId) {
            return res.status(400).json({ success: false, error: 'postId required' });
        }

        // 1. Firestore se post fetch karo — media URLs lene ke liye
        const postDoc = await db.collection('posts').doc(postId).get();

        if (!postDoc.exists) {
            return res.status(404).json({ success: false, error: 'Post not found' });
        }

        const postData = postDoc.data();

        // 2. ☁️ Cloudinary se saari media delete karo
        if (postData.media && postData.media.length > 0) {
            console.log(`☁️ Deleting ${postData.media.length} media file(s) from Cloudinary...`);
            await deletePostMediaFromCloudinary(postData.media);
        }

        // 3. Firestore se post delete karo
        await db.collection('posts').doc(postId).delete();
        console.log(`✅ Post ${postId} deleted from Firestore.`);

        // 4. RTDB Search Index se hatao
        await dbRT.ref(`search_index/${postId}`).remove();
        console.log(`✅ Post ${postId} removed from Search Index.`);

        // 5. Global Sync Signal
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
// 🕐 AUTO EXPIRY DELETE (Cron — har ghante chale)
// GET /api/cleanup-expired
// ============================================
app.get('/api/cleanup-expired', async (req, res) => {
    try {
        const now    = new Date();
        const nowISO = now.toISOString();

        const snapshot = await db.collection('posts')
            .where('expiresAt', '<=', nowISO)
            .where('isExpired', '==', false)
            .get();

        if (snapshot.empty) {
            return res.json({ success: true, message: 'No expired posts found.', deleted: 0 });
        }

        let deleted = 0;

        for (const docSnap of snapshot.docs) {
            const post   = docSnap.data();
            const expiry = new Date(post.expiresAt);

            if (now >= expiry) {

                // ☁️ Cloudinary se media delete karo pehle
                if (post.media && post.media.length > 0) {
                    console.log(`☁️ Deleting media for expired post ${docSnap.id}...`);
                    await deletePostMediaFromCloudinary(post.media);
                }

                // Firestore se delete
                await db.collection('posts').doc(docSnap.id).delete();

                // RTDB Search Index se hatao
                await dbRT.ref('search_index/' + docSnap.id).remove();

                // Global Sync Signal
                await dbRT.ref('global_sync').set({
                    lastUpdate:    Date.now(),
                    target:        'all_caches',
                    updatedPostId: docSnap.id,
                    action:        'expired_deleted'
                });

                console.log(`✅ Expired post deleted: ${docSnap.id}`);
                deleted++;
            }
        }

        return res.json({ success: true, deleted, message: `${deleted} expired post(s) deleted.` });

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
        version:   '2.0.0',
        endpoints: [
            'POST   /api/update-post',
            'DELETE /api/delete-post',
            'GET    /api/cleanup-expired'
        ]
    });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => console.log('Server: http://localhost:' + PORT));
}
