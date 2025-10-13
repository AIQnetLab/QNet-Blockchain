# ⚠️ IMPORTANT: Keystore Configuration

## For Team Members

This app requires a keystore file for signing releases. The keystore is NOT included in the repository for security reasons.

### If you need to build a release:

1. **Get the keystore from the team lead** (securely, not via public channels)
2. Place it in: `android/app/qnet-release-key.keystore`
3. The build.gradle is already configured with the keystore settings

### If you're creating a new keystore:

1. Update the passwords in `android/app/build.gradle` (lines 96-99)
2. Keep the keystore file SAFE and NEVER commit it
3. Share securely with team members who need it

### Files that should NEVER be committed:

- `*.keystore` (except debug.keystore)
- `*.jks`
- Any file with passwords or API keys
- `gradle.properties` with signing configs
- `local.properties`

### Current keystore info (for reference only):
- Filename: `qnet-release-key.keystore`
- Alias: `qnet-key-alias`
- Valid for: 10,000 days from Oct 2024

⚠️ **LOSING THE KEYSTORE = CANNOT UPDATE THE APP ON GOOGLE PLAY**

Make backups in multiple secure locations!
