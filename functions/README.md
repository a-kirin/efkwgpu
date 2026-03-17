# nativeConvert Cloud Function

## Endpoint

- Function name: `nativeConvert`
- HTTP POST body:
  - `sourceName` (`.efkefc` or `.efkpkg`)
  - `sourceBase64`
  - `injectMesh` (optional, default `true`)
  - `deps[]` (optional)

## Local emulator setup

1. Install dependencies:
   - `cd functions`
   - `npm install`
2. Start emulator from project root:
   - `firebase emulators:start --only functions`

The function can build and execute converter tools directly from this repo layout.

## Deployed environment (important)

Cloud Functions runtime usually does not include the .NET SDK by default.

Set one of these strategies:

- Provide prebuilt DLL paths via env vars:
  - `NATIVE_CONVERTER_DLL`
  - `MESH_INJECTOR_DLL`
  - `NATIVE_MESH_PATH`
- Or provide csproj paths + .NET availability:
  - `NATIVE_CONVERTER_CSPROJ`
  - `MESH_INJECTOR_CSPROJ`
  - `EFFEKSEER_ROOT_DIR`

## Frontend endpoint override

Set in `.env`:

`VITE_NATIVE_CONVERT_ENDPOINT=https://<region>-<project>.cloudfunctions.net/nativeConvert`
