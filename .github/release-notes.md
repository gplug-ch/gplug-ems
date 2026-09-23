## Downloads

| File | Language | UI assets |
|------|----------|-----------|
| `ems-@VERSION@.tapp` | German | loaded from the CDN (default) |
| `ems-@VERSION@-en.tapp` | English | loaded from the CDN |
| `ems-@VERSION@-self.tapp` | German | packed into the `.tapp` — for networks without internet access |
| `ems-@VERSION@-en-self.tapp` | English | packed into the `.tapp` — for networks without internet access |

Pick **one** file.

## Installing

Tasmota starts every `*.tapp` in the filesystem root, and the version is part of
the file name — uploading a new release next to the old one boots both apps and
sends an ESP32-C3 into a reboot loop. So:

1. In the Tasmota web UI open **Tools → Manage File system** and **delete every
   existing `ems-*.tapp`**.
2. Upload the new `.tapp` there.
3. Restart the device. `site.json` is kept.

From a checkout of this repository, `ems/backend/deploy.sh <device-ip> ems-@VERSION@.tapp`
does all three steps.
