import 'dotenv/config';
import express from 'express';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import drive from './drive.js';
import Seedr from './seedr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception (server stays alive):', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection (server stays alive):', reason);
});

// Validate Seedr credentials
const SEEDR_EMAIL = process.env.SEEDR_EMAIL;
const SEEDR_PASSWORD = process.env.SEEDR_PASSWORD;
const APP_PASSWORD = process.env.APP_PASSWORD || 'admin123';

if (!SEEDR_EMAIL || !SEEDR_PASSWORD || SEEDR_EMAIL === 'your_seedr_email@example.com') {
    console.error('\n❌ ERROR: Please set your Seedr credentials in the .env file!');
    console.error('   Edit .env and replace the placeholder values.\n');
    process.exit(1);
}

const seedr = new Seedr(SEEDR_EMAIL, SEEDR_PASSWORD);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

app.use(express.json());

// Password verification endpoint
app.post('/api/verify-password', (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Wrong password' });
    }
});

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Clean up torrent filenames before uploading
function cleanFileName(filename) {
    const ext = path.extname(filename);
    let name = filename.slice(0, -ext.length);

    name = name.replace(/^www\.[^\s_-]+[_\-\s]+/i, '');
    name = name.replace(/[_\-]+/g, ' ');
    name = name.replace(/\s{2,}/g, ' ').trim();

    return name + ext;
}

// Extract the movie name from a cleaned filename
function getMovieName(cleanedFilename) {
    const nameWithoutExt = cleanedFilename.replace(path.extname(cleanedFilename), '');

    const match = nameWithoutExt.match(/^(.+?)\s+\d{4}/);
    if (match) return match[1].trim();

    const fallback = nameWithoutExt.match(/^(.+?)\s+(Tamil|Hindi|Telugu|Malayalam|Kannada|English|TRUE|WEB|HDRip|DVDRip|BluRay)/i);
    if (fallback) return fallback[1].trim();

    return nameWithoutExt.trim();
}

// Find the largest file in Seedr folder contents
function findLargestFile(folderData) {
    let largest = null;
    if (folderData.files && folderData.files.length > 0) {
        for (const file of folderData.files) {
            if (!largest || file.size > largest.size) {
                largest = file;
            }
        }
    }
    return largest;
}

io.on('connection', (socket) => {
    console.log('A user connected');
    let authenticated = false;

    // Password check via socket
    socket.on('auth', (password, callback) => {
        if (password === APP_PASSWORD) {
            authenticated = true;
            callback({ success: true });
        } else {
            callback({ success: false });
        }
    });

    socket.on('start-transfer', async (magnetLink) => {
        if (!authenticated) {
            socket.emit('error', 'Not authenticated. Please enter the password.');
            return;
        }

        console.log(`Received magnet link: ${magnetLink}`);

        try {
            // ── Stage 1: Login & Add magnet to Seedr ──
            socket.emit('stage', { stage: 1, label: 'Adding magnet to Seedr...' });
            socket.emit('log', 'Logging into Seedr...');

            await seedr.login();
            socket.emit('log', 'Seedr login OK!');
            socket.emit('log', 'Sending magnet link to Seedr...');

            const addResult = await seedr.addMagnet(magnetLink);
            console.log('Seedr addMagnet result:', JSON.stringify(addResult));

            if (addResult.result === false || addResult.error) {
                throw new Error(addResult.error || addResult.message || 'Seedr rejected the magnet link');
            }

            socket.emit('log', `Magnet added! Title: ${addResult.title || 'processing...'}`);

            // ── Stage 2: Wait for Seedr to download ──
            socket.emit('stage', { stage: 2, label: 'Seedr is downloading...' });

            const rootAfterDownload = await seedr.waitForDownload(({ progress, title, status }) => {
                socket.emit('log', `Seedr: ${progress}% — ${title}`);
                socket.emit('progress', { stage: 'seedr', percent: progress });
                console.log(`Seedr: ${progress}% — ${title}`);
            });

            socket.emit('log', 'Seedr download complete!');

            // ── Stage 3: Find the downloaded file ──
            socket.emit('stage', { stage: 3, label: 'Finding downloaded file...' });
            socket.emit('log', 'Looking for file in Seedr...');

            const rootContents = rootAfterDownload || await seedr.getFolderContents();

            let targetFile = null;
            let targetFolderId = null;

            if (rootContents.folders && rootContents.folders.length > 0) {
                const folder = rootContents.folders[rootContents.folders.length - 1];
                targetFolderId = folder.id;

                const folderContents = await seedr.getFolderContents(folder.id);
                targetFile = findLargestFile(folderContents);

                if (targetFile && targetFile.folder_file_id) {
                    targetFile.id = targetFile.folder_file_id;
                }
            }

            if (!targetFile) {
                targetFile = findLargestFile(rootContents);
                if (targetFile && targetFile.folder_file_id) {
                    targetFile.id = targetFile.folder_file_id;
                }
            }

            if (!targetFile) {
                throw new Error('Could not find downloaded file in Seedr.');
            }

            const originalName = targetFile.name;
            const fileSize = targetFile.size || 0;
            const cleanedName = cleanFileName(originalName);
            const movieName = getMovieName(cleanedName);

            socket.emit('log', `Found: ${originalName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
            socket.emit('log', `Clean name: ${cleanedName}`);
            socket.emit('log', `Drive folder: ${movieName}`);

            // ── Stage 4: Upload to Google Drive ──
            socket.emit('stage', { stage: 4, label: 'Uploading to Google Drive...' });

            socket.emit('log', `Creating Drive folder "${movieName}"...`);
            const driveFolderId = await drive.findOrCreateFolder(movieName);
            socket.emit('log', 'Folder ready! Streaming from Seedr to Drive...');

            const { stream, contentLength, contentType } = await seedr.downloadFileStream(targetFile.id);
            const mimeType = contentType || 'application/octet-stream';
            const uploadSize = contentLength || fileSize;

            const driveFileId = await drive.uploadStream(
                cleanedName, stream, mimeType, uploadSize,
                (progressEvent) => {
                    if (uploadSize && progressEvent.bytesRead) {
                        const percent = ((progressEvent.bytesRead / uploadSize) * 100).toFixed(1);
                        socket.emit('progress', { stage: 'drive', percent: parseFloat(percent) });
                    }
                },
                driveFolderId
            );

            socket.emit('log', `Upload complete! Drive File ID: ${driveFileId}`);

            // ── Stage 4b: Make publicly accessible ──
            socket.emit('log', 'Setting sharing permissions...');
            try {
                await drive.makePublic(driveFolderId);
                const shareLink = await drive.makePublic(driveFileId);
                socket.emit('log', '🔗 File is now public (anyone with the link)');
                socket.emit('share-link', shareLink);
            } catch (shareErr) {
                socket.emit('log', `⚠ Sharing warning: ${shareErr.message}`);
            }

            // ── Stage 5: Cleanup Seedr ──
            socket.emit('stage', { stage: 5, label: 'Cleaning up Seedr...' });
            socket.emit('log', 'Deleting from Seedr...');

            try {
                if (targetFolderId) {
                    await seedr.deleteFolder(targetFolderId);
                } else if (targetFile.id) {
                    await seedr.deleteFile(targetFile.id);
                }
                socket.emit('log', 'Seedr cleaned up!');
            } catch (cleanupErr) {
                socket.emit('log', `⚠ Cleanup warning: ${cleanupErr.message}`);
            }

            socket.emit('success', `✅ "${cleanedName}" uploaded to Drive in folder "${movieName}"!`);

        } catch (err) {
            console.error('Transfer error:', err);
            const errorMsg = err.response?.data?.error || err.response?.data?.message || err.message;
            socket.emit('error', `Transfer failed: ${errorMsg}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(port, () => {
    console.log(`\n🚀 Server listening on http://localhost:${port}`);
    console.log(`📧 Seedr: ${SEEDR_EMAIL}`);
    console.log(`🔒 Password protected: YES`);
    console.log(`📁 Flow: Magnet → Seedr → Google Drive\n`);

    // Only open browser locally, not on cloud
    if (!process.env.RENDER && !process.env.NODE_ENV) {
        import('open').then(m => m.default(`http://localhost:${port}`));
    }
});
