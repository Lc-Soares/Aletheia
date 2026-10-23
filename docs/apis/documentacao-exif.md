
# ExifTools API Documentation

Extract metadata from files using our simple and powerful API.

## Base URL
```
https://exiftools.com/api/v1
```

## Authentication

All API requests require an API key. You can provide it in two ways:

### 1. In the request header:
```http
X-API-Key: YOUR_API_KEY_HERE
```

### 2. As a query parameter:
```http
?key=YOUR_API_KEY_HERE
```

### How to Get an API Key

1. Visit https://exiftools.com/api-keys
2. Sign in or create a free account
3. Click "Generate New API Key"
4. Copy your API key and use it in your requests
5. Keep your API key secure and never share it publicly

## Endpoints

### 1. Extract Metadata

**POST** `https://exiftools.com/api/v1/extract`

Extract metadata from a file using a direct file upload, a URL, or a base64 data URL. Results are returned immediately (synchronous processing).

#### Request Parameters

Provide exactly one of the following:

**Option 1: File Upload**
```json
{
  "file": "binary_file_data"
}
```

**Option 2: URL Processing**
```json
{
  "url": "https://example.com/image.jpg"
}
```

**Option 3: Data URL (base64)**
```json
{
  "data_url": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

#### Example Response (Success)
```json
{
  "success": true,
  "status": "completed",
  "fileName": "image.jpg",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "processedAt": "2026-03-15T10:31:02+00:00",
  "author": "John Doe", // author, createDate, dimensions, cameraModel: only when the file has them
  "createDate": "2026-03-15 10:30:00",
  "fileSize": "4.2 MB",
  "fileSizeBytes": 4404019,
  "mimeType": "image/jpeg",
  "dimensions": "8192x5464",
  "cameraModel": "Canon EOS R5",
  "metadata": {
    "File": {
      "FileType": "JPEG",
      "MIMEType": "image/jpeg",
      "FileSize": "4.2 MB",
      "ImageWidth": 8192,
      "ImageHeight": 5464,
      "SHA256": "a5e50cbe66078249973d9a71230c4a8edbaedc26af11204042d3bce1f9ed4409"
    },
    "EXIF": {
      "Make": "Canon",
      "Model": "Canon EOS R5",
      "DateTimeOriginal": "2026:03:15 10:30:00",
      "ExposureTime": "1/1000",
      "FNumber": 2.8,
      "ISO": 100
    },
    "IPTC": {
      "By-line": "John Doe",
      "CopyrightNotice": "© 2026 John Doe"
    }
    // ... more groups: XMP, GPS, ICC_Profile, MakerNotes, Composite…
  }
}
```

The response has the same fields as Get Extraction Results. PDF and Office files also get an embedded block, usually still "pending" right after upload: get the result again a few seconds later to see the files (see Embedded Files).

#### Error Responses

**400 Bad Request**
```json
{
  "success": false,
  "error": "Invalid request parameters"
}
```

**401 Unauthorized**
```json
{
  "success": false,
  "error": "Invalid API key"
}
```

**500 Internal Server Error**
```json
{
  "success": false,
  "error": "An error occurred while processing your request"
}
```

### 2. Get Extraction Results

**GET** `https://exiftools.com/api/v1/extract/{uuid}`

Retrieve the metadata extraction results for a specific UUID. Requires your API key.

#### Request Parameters
```
{uuid} - The UUID returned from the extract endpoint
X-API-Key (required) - API key in header, or use ?key=YOUR_API_KEY
```

#### Example Response (Completed)
```json
{
  "success": true,
  "status": "completed",
  "fileName": "image.jpg",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "processedAt": "2026-03-15T10:31:02+00:00",
  "author": "John Doe", // author, createDate, dimensions, cameraModel: only when the file has them
  "createDate": "2026-03-15 10:30:00",
  "fileSize": "4.2 MB",
  "fileSizeBytes": 4404019,
  "mimeType": "image/jpeg",
  "dimensions": "8192x5464",
  "cameraModel": "Canon EOS R5",
  "metadata": {
    "File": {
      "FileType": "JPEG",
      "MIMEType": "image/jpeg",
      "FileSize": "4.2 MB",
      "ImageWidth": 8192,
      "ImageHeight": 5464,
      "SHA256": "a5e50cbe66078249973d9a71230c4a8edbaedc26af11204042d3bce1f9ed4409"
    },
    "EXIF": {
      "Make": "Canon",
      "Model": "Canon EOS R5",
      "DateTimeOriginal": "2026:03:15 10:30:00",
      "ExposureTime": "1/1000",
      "FNumber": 2.8,
      "ISO": 100
    },
    "IPTC": {
      "By-line": "John Doe",
      "CopyrightNotice": "© 2026 John Doe"
    }
    // ... more groups: XMP, GPS, ICC_Profile, MakerNotes, Composite…
  },
  "embedded": {
    "status": "done",
    "count": 1,
    "zip": "https://exiftools.com/api/v1/results/{uuid}/embedded.zip",
    "items": [
      {
        "position": 1,
        "kind": "image",
        "mime": "image/jpeg",
        "ext": "jpg",
        "bytes": 64753,
        "width": 1023,
        "height": 158,
        "page": 1,
        "name": null,
        "risky": false,
        "url": "https://exiftools.com/api/v1/results/{uuid}/embedded/1"
      }
    ]
  }
}
```

`embedded` appears on PDF and Office results only: every file found inside the document, each with its download link, and a ZIP of all of them (see Embedded Files).

`contentCredentials` appears on files with Content Credentials only: the result of checking their C2PA signature (see Content Credentials).

author, createDate, dimensions and cameraModel appear only when the file has them. metadata is grouped the way ExifTool names the groups (File, EXIF, IPTC, XMP, GPS, ICC_Profile, Composite…); which groups and tags appear depends on the file.

#### Error Responses

**401 Unauthorized** (only when invalid API key provided)
```json
{
  "success": false,
  "error": "Invalid API key"
}
```

**404 Not Found**
```json
{
  "success": false,
  "error": "No extraction found with the given UUID."
}
```

### 3. Embedded Files

**GET** `https://exiftools.com/api/v1/results/{uuid}/embedded/{position}` (one file)
**GET** `https://exiftools.com/api/v1/results/{uuid}/embedded.zip` (all files)

For a PDF or Office document (docx, xlsx, pptx, OpenDocument), the result's `embedded` block lists the images, video, audio and attached files found inside it, each with a download `url`, plus a `zip` of all of them. The links need your API key (X-API-Key header or ?key=); without it they are null and the files answer 403.

- `status`: pending (get the result again in a few seconds) | done | partial (a limit was reached; only the first files are listed) | failed (the document could not be read, e.g. it needs a password).
- `kind`: image | video | audio | document | archive | other. `page` is the PDF page or slide number; `name` an attachment's own file name; `risky` marks programs, scripts and macros.
- Add `?view=1` to a file url to get images, video, audio and PDFs inline instead of as a download. Risky files always download.

### 4. Content Credentials

Files that carry Content Credentials (C2PA) get a `contentCredentials` block in their result. We check them during extraction with the official C2PA tools, offline.

```json
"contentCredentials": {
  "state": "trusted_legacy",
  "signer": "Adobe Inc.",
  "certificateName": "cai-prod",
  "trustList": "itl",
  "signedAt": "2023-10-02T16:51:02+00:00",
  "timestamped": true,
  "algorithm": "Ps256",
  "generator": "Adobe Firefly 1.0",
  "title": "Generated image",
  "aiGenerated": true,
  "digitalSourceTypes": ["ai"],
  "actions": [{ "action": "c2pa.created", "softwareAgent": "Adobe Firefly", "digitalSourceType": "ai" }],
  "ingredients": [],
  "creator": [],
  "aiTraining": [],
  "checks": [{ "code": "assertion.dataHash.match", "outcome": "success" }],
  "manifestUrl": "https://exiftools.com/results/{uuid}/credentials?format=manifest",
  "checkedAt": "2026-10-15T16:36:48+00:00"
}
```

- `state`: trusted (signer on the C2PA Trust List) | trusted_legacy (signer on the earlier Content Credentials list, frozen in 2026 but valid for what it signed) | valid (signature and file intact, signer on no trusted list) | invalid (with `reason`: changed, signature or expired) | remote (credentials stored online, not fetched; `remoteHost`) | unchecked (a result from before the check) | error.
- `trustList`: c2pa | itl. A trusted signer says who made the file, not that its content is true.
- `checks`: every C2PA validation result, with its status code and outcome (success | info | failure). `ingredients`: the files it was made from, as a tree. `manifestUrl`: the whole C2PA manifest as JSON. Revocation is not checked online.

### 5. Remove Metadata

**POST** `https://exiftools.com/api/v1/remove`

Remove all metadata from a file including EXIF data, GPS location, IPTC, XMP, and other sensitive information. Upload a file directly, provide a URL, or send a base64 data URL to process. Receive a cleaned version without any embedded metadata.

#### Request Parameters

Provide exactly one of the following:

**Option 1: File Upload**
```json
{
  "file": "binary_file_data"
}
```

**Option 2: URL Processing**
```json
{
  "url": "https://example.com/image.jpg"
}
```

**Option 3: Data URL (base64)**
```json
{
  "data_url": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

#### Example Response (Success)
```json
{
  "success": true,
  "status": "completed",
  "uuid": "123e4567-e89b-12d3-a456-426614174000",
  "downloadUrl": "https://exiftools.com/download-cleaned/123e4567-e89b-12d3-a456-426614174000"
}
```

The downloadUrl provides a direct link to download the cleaned file with all metadata removed. The file will be available for download for 24 hours.

#### Error Responses

**400 Bad Request**
```json
{
  "success": false,
  "error": "No file provided"
}
```

**401 Unauthorized**
```json
{
  "success": false,
  "error": "Invalid API key"
}
```

**413 Payload Too Large**
```json
{
  "success": false,
  "error": "File size exceeds maximum limit of 100MB"
}
```

**415 Unsupported Media Type**
```json
{
  "success": false,
  "error": "File format not supported"
}
```

**500 Internal Server Error**
```json
{
  "success": false,
  "error": "An error occurred while processing your request"
}
```

## Code Examples

### cURL

```bash
# File Upload - Using header
curl -X POST https://exiftools.com/api/v1/extract \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -F "file=@image.jpg"

# File Upload - Using query parameter
curl -X POST "https://exiftools.com/api/v1/extract?key=YOUR_API_KEY_HERE" \
  -F "file=@image.jpg"

# URL Processing - Using header
curl -X POST https://exiftools.com/api/v1/extract \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/image.jpg"}'

# URL Processing - Using query parameter
curl -X POST "https://exiftools.com/api/v1/extract?key=YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/image.jpg"}'

# Data URL (base64) - encode a local file inline - Using header
curl -X POST https://exiftools.com/api/v1/extract \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"data_url\": \"data:image/jpeg;base64,$(base64 -i image.jpg)\"}"

# Data URL (base64) - encode a local file inline - Using query parameter
curl -X POST "https://exiftools.com/api/v1/extract?key=YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"data_url\": \"data:image/jpeg;base64,$(base64 -i image.jpg)\"}"

# Get results by UUID - Using header
curl -X GET https://exiftools.com/api/v1/extract/123e4567-e89b-12d3-a456-426614174000 \
  -H "X-API-Key: YOUR_API_KEY_HERE"

# Get results by UUID - Using query parameter
curl -X GET "https://exiftools.com/api/v1/extract/123e4567-e89b-12d3-a456-426614174000?key=YOUR_API_KEY_HERE"

# Remove Metadata - File Upload - Using header
curl -X POST https://exiftools.com/api/v1/remove \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -F "file=@image.jpg"

# Remove Metadata - File Upload - Using query parameter
curl -X POST "https://exiftools.com/api/v1/remove?key=YOUR_API_KEY_HERE" \
  -F "file=@image.jpg"

# Remove Metadata - URL Processing - Using header
curl -X POST https://exiftools.com/api/v1/remove \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/image.jpg"}'

# Remove Metadata - URL Processing - Using query parameter
curl -X POST "https://exiftools.com/api/v1/remove?key=YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/image.jpg"}'

# Remove Metadata - Data URL (base64) - Using header
curl -X POST https://exiftools.com/api/v1/remove \
  -H "X-API-Key: YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"data_url\": \"data:image/jpeg;base64,$(base64 -i image.jpg)\"}"

# Remove Metadata - Data URL (base64) - Using query parameter
curl -X POST "https://exiftools.com/api/v1/remove?key=YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"data_url\": \"data:image/jpeg;base64,$(base64 -i image.jpg)\"}"
```

## Notes

- All requests return JSON responses
- Files and URLs are processed synchronously with immediate results
- The UUID from the response can be used to retrieve results later
- Maximum file size: 100MB for a file sent in the request (`file` or `data_url`); up to 2GB for a file loaded from a `url`
- Supported formats: Images (JPEG, PNG, TIFF, etc.), Videos (MP4, MOV, etc.), Audio files, PDFs, and more
    