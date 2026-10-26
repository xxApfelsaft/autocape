const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const DiscordOAuth2 = require('discord-oauth2');
const express = require('express');
const cors = require('cors');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const config = require('./config.json');

const app = express();
app.use(cors());

const oauth = new DiscordOAuth2({
    clientId: config.discordclientid,
    clientSecret: config.discordsecret,
    redirectUri: config.redirecturi,
});

let fullUrl = config.hostname;
if (config.portneeded === "true") {
    if (!config.port) {
        console.error("No port specified in config.json");
        process.exit(1);
    }
    fullUrl = `${config.hostname}:${config.port}`;
}

const resultsDir = path.join(__dirname, "results");
if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir);
}

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const multer = require('multer');
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        let ext = path.extname(file.originalname || '');
        if (!ext) {
            if (file.mimetype === 'image/gif') ext = '.gif';
            else if (file.mimetype === 'image/jpeg') ext = '.jpg';
            else ext = '.png';
        }
        const uniqueName = `${Date.now()}-${generateResultId(8)}${ext}`;
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ err: 'no file' });
    res.json({ path: req.file.filename });
});

app.get('/media/:filename', (req, res) => {
    const file = path.join(uploadsDir, req.params.filename);
    if (fs.existsSync(file)) {
        res.sendFile(file);
    } else {
        res.sendStatus(404);
    }
});

app.get('/template.png', (req, res) => res.sendFile(path.join(__dirname, 'template.png')));

function renderError(errorMessage, displayError) {
    const htmlData = fs.readFileSync(path.join(__dirname, "pages/error.html"), 'utf8');
    const errorId = `ERR:${generateResultId(15)}`;
    const errorTime = `${errorId} - ${errorMessage} @ ${Date.now()}`;

    console.error(errorTime);
    
    return htmlData
        .replaceAll("{{error}}", displayError)
        .replaceAll("{{errorid}}", errorId);
}

function generateResultId(length) {
    const characters = '0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result + Date.now();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pages/index.html')));
app.get('/resize', (req, res) => res.sendFile(path.join(__dirname, "pages/resizerui.html")));
app.get('/js/localize.js', (req, res) => res.sendFile(path.join(__dirname, "pages/localize.js")));

app.get('/localize/:languagecode/:pageid', (req, res) => {
    const filePath = path.join(__dirname, "pages/localizejs", req.params.languagecode, `${req.params.pageid}.json`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.sendStatus(404);
    }
});

app.get("/cape/:id", (req, res) => {
    let id = req.params.id;
    if (!id) return res.send(renderError("Error: 400 - malformed @ /cape : no valid params passed", "400 - Malformed Data"));

    id = id.replace(/\.(gif|png)$/i, "");

    let file = path.join(resultsDir, `${id}.gif`);
    if (fs.existsSync(file)) {
        res.type('image/gif');
        return res.sendFile(file);
    }

    file = path.join(resultsDir, `${id}.png`);
    if (fs.existsSync(file)) {
        res.type('image/png');
        return res.sendFile(file);
    }

    res.send(renderError(`Error: 404 - Not found @ /cape : id ${id} ip: ${req.ip}`, "404 - The page you requested was not found."));
});

app.get('/authendpoint', async (req, res) => {
    const code = req.query.code;
    try {
        const token = await oauth.tokenRequest({
            code,
            scope: ['identify'],
            grantType: 'authorization_code',
        });
        const user = await oauth.getUser(token.access_token);
        res.send(user);
    } catch (err) {
        console.error(err);
        res.send(renderError(`Error: 500 - Internal server error @ /authendpoint : ${err}`, "500 - Internal Server Error"));
    }
});

app.get('/result', (req, res) => res.send(renderError("Error: 400 - Malformed @ /result : no valid params passed", "400 - Malformed Data")));

app.get("/result/:id", (req, res) => {
    let id = req.params.id;
    if (!id) return res.send(renderError(`Error: 400 - Malformed @ /result/:id :id ${id}`, "400 - Malformed Data"));

    id = id.replace(/\.(gif|png)$/i, "");

    const gifFile = path.join(resultsDir, `${id}.gif`);
    const pngFile = path.join(resultsDir, `${id}.png`);
    if (!fs.existsSync(gifFile) && !fs.existsSync(pngFile)) {
        return res.send(renderError(`Error: 404 - Not found @ /result/:id :id ${id}`, "404 - The page you requested was not found."));
    }

    const htmlData = fs.readFileSync(path.join(__dirname, "pages/result.html"), 'utf8');
    const protocol = config.protocol || (config.portneeded === "true" ? "http" : "https");
    const ext = fs.existsSync(gifFile) ? "gif" : "png";
    const targetUrl = `${protocol}://${fullUrl}/cape/${id}.${ext}`;
    
    const replaced = htmlData
        .replaceAll("{{imgurl}}", targetUrl)
        .replaceAll("{{imgurl2}}", targetUrl);

    res.send(replaced);
});

app.get('/makecape', async (req, res) => {
    const forceRender = req.query.fromeditor === "true";
    const customColor = req.query.customcolour;
    const useColorMatch = customColor ? "custom" : (req.query.colourmatch || "false");
    const stateId = req.query.stateid;
    const baseImageLocation = req.query.img;
    const startTime = Date.now();

    const cropX = req.query.cropx !== undefined ? parseFloat(req.query.cropx) : null;
    const cropY = req.query.cropy !== undefined ? parseFloat(req.query.cropy) : null;
    const cropW = req.query.cropw !== undefined ? parseFloat(req.query.cropw) : null;
    const cropH = req.query.croph !== undefined ? parseFloat(req.query.croph) : null;
    const crop = (cropW != null && cropH != null) ? { x: cropX, y: cropY, width: cropW, height: cropH } : null;

    if (!baseImageLocation) return res.json({ err: "missingimg" });

    const cleanLocation = baseImageLocation.split('?')[0].toLowerCase();
    const allowedExtensions = ['.png', '.gif', '.jpg', '.jpeg', '.webp'];
    if (!allowedExtensions.some(ext => cleanLocation.endsWith(ext))) {
        return res.json({ err: "notfound" });
    }

    let imageBuffer;
    if (baseImageLocation.startsWith('/media/') || baseImageLocation.includes('/media/')) {
        const filename = baseImageLocation.split('/media/').pop().split('?')[0];
        const localFile = path.join(uploadsDir, filename);
        if (fs.existsSync(localFile)) {
            imageBuffer = fs.readFileSync(localFile);
        }
    }

    if (!imageBuffer) {
        if (!baseImageLocation.startsWith('http')) return res.json({ err: "disallowedprotocol" });
        try {
            const response = await axios.get(baseImageLocation, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CapeGenerator/1.0)' }
            });
            imageBuffer = response.data;
        } catch (err) {
            return res.json({ err: "downloadfailed" });
        }
    }

    try {
        const outputBuffer = await generateCape(imageBuffer, {
            forceRender,
            useColorMatch,
            customColor,
            baseImageLocation,
            startTime,
            crop
        });

        if (outputBuffer === "err:aspectratio") {
            return res.json({ err: "aspectratio" });
        }

        res.setHeader('resultid', outputBuffer);
        res.json({ resultid: outputBuffer });

        if (stateId) {
            axios.get(`${config.boturl}/replace?stateid=${stateId}&resultid=${outputBuffer}`)
                .catch(err => console.error('bot err: ', err));
        }

    } catch (error) {
        console.error("img processing err:", error);
        res.json({ err: "processing_error" });
    }
});

async function generateCape(imageBuffer, options) {
    const meta = await sharp(imageBuffer, { animated: true }).metadata();
    const isAnimated = meta.format === 'gif' && (meta.pages || 1) > 1;
    const numPages = isAnimated ? meta.pages : 1;
    const delays = (meta.delay && meta.delay.length > 0) ? meta.delay : [];

    // Max frames safeguard (up to 60 frames)
    const maxFrames = 60;
    const step = numPages > maxFrames ? Math.ceil(numPages / maxFrames) : 1;

    // First frame metadata
    const firstFrameMeta = isAnimated
        ? await sharp(imageBuffer, { page: 0 }).metadata()
        : meta;
    const widthOg = firstFrameMeta.width;
    const heightOg = firstFrameMeta.pageHeight || firstFrameMeta.height;
    const format = meta.format;

    if (!options.crop) {
        const aspectRatioOg = widthOg / heightOg;
        let aspectRatio = Math.round(aspectRatioOg * 1000) / 1000;
        if (options.forceRender) {
            aspectRatio = 0.625;
        }
        if (aspectRatio !== 0.625) {
            console.log('Incorrect aspect ratio');
            return "err:aspectratio";
        }
    }

    // Function to extract and scale a single frame to 320x512
    async function get320x512Frame(pageIdx) {
        const frameSharp = isAnimated
            ? sharp(imageBuffer, { page: pageIdx })
            : sharp(imageBuffer);

        if (options.crop && options.crop.width > 0 && options.crop.height > 0) {
            const frameMeta = isAnimated ? await frameSharp.metadata() : firstFrameMeta;
            const fW = frameMeta.width;
            const fH = frameMeta.pageHeight || frameMeta.height;
            const left = Math.max(0, Math.min(Math.round(options.crop.x), fW - 1));
            const top = Math.max(0, Math.min(Math.round(options.crop.y), fH - 1));
            const width = Math.min(Math.round(options.crop.width), fW - left);
            const height = Math.min(Math.round(options.crop.height), fH - top);
            return await frameSharp
                .extract({ left, top, width, height })
                .resize(320, 512, { fit: 'fill' })
                .png()
                .toBuffer();
        } else {
            return await frameSharp
                .resize(320, 512, { fit: 'fill' })
                .png()
                .toBuffer();
        }
    }

    const firstFrame320 = await get320x512Frame(0);
    let hexColor = "121713"; 

    if (options.useColorMatch === "true") {
        const stats = await sharp(firstFrame320).stats();
        const [rc, gc, bc] = stats.channels;
        const r = Math.round(rc.mean);
        const g = Math.round(gc.mean);
        const b = Math.round(bc.mean);
        hexColor = ((r << 16) + (g << 8) + b).toString(16).padStart(6, '0');

    } else if (options.useColorMatch === "border") {
        const borderMeta = await sharp(firstFrame320).metadata();
        const tops = await sharp(firstFrame320)
            .extract({ left: 0, top: 0, width: borderMeta.width, height: 1 })
            .toBuffer();
        const bottoms = await sharp(firstFrame320)
            .extract({ left: 0, top: borderMeta.height - 1, width: borderMeta.width, height: 1 })
            .toBuffer();

        const fill = await sharp({
            create: {
                width: borderMeta.width,
                height: borderMeta.height,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        })
            .composite([{ input: tops }, { input: bottoms }])
            .toBuffer();

        const stats = await sharp(fill).stats();
        const [rc, gc, bc] = stats.channels;
        const r = Math.round(rc.mean);
        const g = Math.round(gc.mean);
        const b = Math.round(bc.mean);
        hexColor = ((r << 16) + (g << 8) + b).toString(16).padStart(6, '0');

    } else if (options.useColorMatch === "custom" && options.customColor) {
        hexColor = options.customColor.replace("#", "");
    }

    const svgTemplate = `
        <svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024" >
            <path transform="translate(1024,0)" d="M0 0H256V32H64V352H0V0Z" fill="#${hexColor}"/>
            <path transform="translate(1088,64)" d="M0 0H256V32H288V64H320V160H352V288H384V640H160V608H128V544H96V448H64V288H32V160V64H0V0Z" fill="#${hexColor}"/>
            <path d="M32 0H672V32H704V352H736V703.913H704V544H32H0V32H32V0Z" fill="#${hexColor}"/>
        </svg>
    `;

    const wingMaskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="640"><path d="M0 0H256V32H288V64H320V160H352V288H384V640H160V608H128V544H96V448H64V288H32V160V64H0V0Z" fill="white"/></svg>`;
    const maskBuffer = Buffer.from(wingMaskSvg);

    const baseCapeBuffer = await sharp(path.join(__dirname, "template.png"))
        .composite([{ input: Buffer.from(svgTemplate), top: 0, left: 0 }])
        .png()
        .toBuffer();

    const gifEncoder = GIFEncoder();

    for (let pageIdx = 0; pageIdx < numPages; pageIdx += step) {
        const frame320 = (pageIdx === 0) ? firstFrame320 : await get320x512Frame(pageIdx);

        const [topEdge, bottomEdge, leftEdge, rightEdge, scaledWingImg, elytraTop, elytraBottom, elytraSide] = await Promise.all([
            sharp(frame320)
                .extract({ left: 0, top: 0, width: 320, height: 1 })
                .resize(320, 32, { fit: 'fill' })
                .toBuffer(),
            sharp(frame320)
                .extract({ left: 0, top: 511, width: 320, height: 1 })
                .resize(320, 32, { fit: 'fill' })
                .toBuffer(),
            sharp(frame320)
                .extract({ left: 0, top: 0, width: 1, height: 512 })
                .resize(32, 512, { fit: 'fill' })
                .toBuffer(),
            sharp(frame320)
                .extract({ left: 319, top: 0, width: 1, height: 512 })
                .resize(32, 512, { fit: 'fill' })
                .toBuffer(),
            sharp(frame320)
                .resize(384, 640, { fit: 'cover' })
                .toBuffer(),
            // Elytra Oben (64x64 at 1024, 0)
            sharp(frame320)
                .extract({ left: 0, top: 0, width: 320, height: 1 })
                .resize(64, 64, { fit: 'fill' })
                .toBuffer(),
            // Elytra Unten (192x32 at 1088, 0)
            sharp(frame320)
                .extract({ left: 0, top: 511, width: 320, height: 1 })
                .resize(192, 32, { fit: 'fill' })
                .toBuffer(),
            // Elytra Rechts (64x288 at 1024, 64)
            sharp(frame320)
                .extract({ left: 0, top: 0, width: 1, height: 288 })
                .resize(64, 288, { fit: 'fill' })
                .toBuffer()
        ]);

        const rightWing = await sharp(scaledWingImg)
            .composite([{ input: maskBuffer, blend: 'dest-in' }])
            .png()
            .toBuffer();

        let fullFrameSharp = sharp(baseCapeBuffer).composite([
            { input: topEdge, top: 0, left: 32 },
            { input: bottomEdge, top: 0, left: 352 },
            { input: leftEdge, top: 32, left: 0 },
            { input: rightEdge, top: 32, left: 352 },
            { input: frame320, top: 32, left: 32 },
            { input: elytraTop, top: 0, left: 1024 },
            { input: elytraBottom, top: 0, left: 1088 },
            { input: elytraSide, top: 64, left: 1024 },
            { input: rightWing, top: 64, left: 1088 }
        ]);

        if (config.isdev === "true" && pageIdx === 0) {
            const renderTime = Date.now() - options.startTime;
            const debugSvg = `
            <svg width="2048" height="1024">
                <style>
                    .title { fill: #FF0000; font-size: 15px; font-weight: bold;}
                </style>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="900px" class="title">${config.version}</text>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="920px" class="title">[DEV MODE]</text>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="940px" class="title">SOURCE: ${options.baseImageLocation}</text>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="960px" class="title">Format: ${format}; Animated: ${isAnimated}; Frames: ${numPages}; Calculated color: #${hexColor}</text>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="980px" class="title">Server Host: ${config.hostname}</text>
                <text font-family="Arial, Helvetica, sans-serif" x="5px" y="1000px" class="title">Render time: ${renderTime}ms</text>
            </svg>
            `;
            fullFrameSharp = fullFrameSharp.composite([{ input: Buffer.from(debugSvg), top: 0, left: 0 }]);
        }

        const rawFrame = await fullFrameSharp
            .raw()
            .ensureAlpha()
            .toBuffer({ resolveWithObject: true });

        const palette = quantize(rawFrame.data, 256, { format: 'rgba4444', oneBitAlpha: 0 });
        const index = applyPalette(rawFrame.data, palette, 'rgba4444');
        let frameDelay = isAnimated ? (delays[pageIdx] || 100) : 0;
        if (isAnimated && frameDelay <= 10) frameDelay = 100;

        gifEncoder.writeFrame(index, rawFrame.info.width, rawFrame.info.height, {
            palette,
            delay: frameDelay,
            transparent: true,
            transparentIndex: 0
        });
    }

    gifEncoder.finish();
    const gifBuffer = Buffer.from(gifEncoder.bytes());

    const resultId = generateResultId(10);
    fs.writeFileSync(path.join(resultsDir, `${resultId}.gif`), gifBuffer);

    return resultId;
}

const server = app.listen(config.port, () => console.log(`App listening on http://${fullUrl} !`));
module.exports = app;