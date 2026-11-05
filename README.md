

File Location Map
File / Directory	Location / Machine	Exact Path	Purpose
r2_watcher.py	Local Windows PC	V:\cam\r2_watcher.py	Python background service that watches S:\HQ-AD and uploads files directly to R2.
r2_watcher.json	Local Windows PC	V:\cam\r2_watcher.json	Configuration file containing your R2 bucket name, Account ID, and S3 credentials.
Live HLS Streams	Local Windows Drive	S:\HQ-AD\<cam>.m3u8


S:\HQ-AD\<cam>_*.ts
	Temporary video chunks created on-the-fly only when a live stream is running.
Snapshots	Local Windows Drive	S:\HQ-AD\snapshots\<cam>\*.jpg	Periodic status still images written by your cameras.
Motion Clips	Local Windows Drive	S:\HQ-AD\motion\<cam>\*.mp4	10-second video recordings. They remain local until requested on-demand.
Cloud Storage	Cloudflare R2	Bucket: aisys-media


Prefix: HQ-AD/
	Cloud copy of live .m3u8/.ts, real-time .jpg snapshots, and on-demand .mp4 files.
worker.js	Cloudflare Worker	GitHub repo / Cloudflare Dashboard	Edge API routing authentication, database queries, and serving media to browsers.
live.js	Web Dashboard / Frontend	Cloudflare Pages or your web assets directory	Client-side script that renders the 2×2 quad snapshot view and requests motion playback.
Detailed Breakdown by Location
1. Local Windows Machine — Scripts Folder (V:\cam\)
This is where your automation scripts live:


•	V:\cam\r2_watcher.py: Run this script via terminal (python r2_watcher.py). It monitors S:\HQ-AD continuously.

•	V:\cam\r2_watcher.json: Sits right next to r2_watcher.py. Contains your S3 API keys and configuration.

2. Local Windows Machine — Camera Storage Drive (S:\HQ-AD\)
This is the storage directory where your camera software or recorder saves media:


•	S:\HQ-AD\apcam.m3u8 and S:\HQ-AD\gate.m3u8: Located directly at the root of HQ-AD. Only present while an active live stream is generated.

•	S:\HQ-AD\snapshots\<cam_name>\: Holds .jpg images written every few seconds.

•	S:\HQ-AD\motion\<cam_name>\: Holds .mp4 video clips. These do not upload automatically; they stay on disk to preserve bandwidth until a user requests them.

3. Cloudflare R2 Storage (aisys-media)
Your bucket mirrors the structure of S:\HQ-AD:


•	HQ-AD/apcam.m3u8 (Live playlists)

•	HQ-AD/snapshots/<cam_name>/*.jpg (Uploaded automatically in real time)

•	HQ-AD/motion/<cam_name>/*.mp4 (Uploaded only after being requested)

•	HQ-AD/requests/*.req (Temporary zero-byte trigger files created by worker.js when a user clicks a snapshot)

4. Cloudflare Worker Edge (worker.js)
This is deployed on Cloudflare (via Git or Wrangler) to handle requests arriving at [https://aisys.cam](https://aisys.cam):


•	Routes user logins against D1.

•	Directs /live/:file requests to R2 live segments.

•	Directs /api/snapshot/latest to R2 snapshot images.

•	Drops .req markers into HQ-AD/requests/ when /api/motion/request is called.

5. Frontend Dashboard (live.js, live.html, style.css)
These are your frontend user interface files served by Cloudflare Pages or the Worker's ASSETS binding:


•	live.html: The HTML structure containing the camera display cards.

•	live.js: Handles polling the 4 latest snapshots, rendering the 2×2 zoomed quad layout, and calling /api/motion/request when a snapshot is clicked.

•	style.css: Contains the CSS grid, zoom transforms, and overlay styles.

How Data Moves Through the Pipeline
Plaintext
[Cameras / Recorder]
         │  Writes JPEGs, MP4s, and HLS
         ▼
[S:\HQ-AD on Windows PC]
         │
         │  r2_watcher.py (running in V:\cam\)
         │  pushed via Boto3 S3 API
         ▼
[Cloudflare R2: aisys-media]
         ▲
         │  env.MEDIA_BUCKET.get()
         ▼
[Cloudflare Worker: worker.js]
         ▲
         │  HTTPS requests (/live/, /api/snapshot/latest)
         ▼
[Browser: live.js & Dashboard]
Which specific step or file in this pipeline are you configuring right now?

# aivision
For video analytics
