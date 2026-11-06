#!/bin/bash
set -euo pipefail

# ==============================================================================
# Installer for Unraid User Scripts or Standard Cron
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_SCRIPT="${SCRIPT_DIR}/sync_library.sh"

chmod +x "$SYNC_SCRIPT"

if [ -d "/boot/config/plugins/user.scripts" ]; then
    echo "Detected Unraid User Scripts plugin..."
    TARGET_DIR="/boot/config/plugins/user.scripts/scripts/Sync BookOrbit to CrossPoint"
    mkdir -p "$TARGET_DIR"
    echo "Sync BookOrbit to CrossPoint" > "${TARGET_DIR}/name"
    cat << EOF > "${TARGET_DIR}/script"
#!/bin/bash
${SYNC_SCRIPT}
EOF
    chmod +x "${TARGET_DIR}/script"

    php -r '
    $schedFile = "/boot/config/plugins/user.scripts/schedule.json";
    $sched = json_decode(file_get_contents($schedFile), true) ?: [];
    $path = "/boot/config/plugins/user.scripts/scripts/Sync BookOrbit to CrossPoint/script";
    $sched[$path] = [
        "script" => $path,
        "frequency" => "custom",
        "id" => "scheduleSyncBookOrbitToCrossPoint",
        "custom" => "*/15 * * * *"
    ];
    file_put_contents($schedFile, json_encode($sched, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    if (file_exists("/tmp/user.scripts/schedule.json")) {
        file_put_contents("/tmp/user.scripts/schedule.json", json_encode($sched, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }
    $cronFile = "/boot/config/plugins/user.scripts/customSchedule.cron";
    $cron = file_exists($cronFile) ? file_get_contents($cronFile) : "";
    if (strpos($cron, $path) === false) {
        $cron .= "*/15 * * * * /usr/local/emhttp/plugins/user.scripts/startCustom.php " . $path . " > /dev/null 2>&1\n";
        file_put_contents($cronFile, $cron);
    }
    '

    if [ -x "/usr/local/sbin/update_cron" ]; then
        /usr/local/sbin/update_cron
    fi
    echo "Successfully installed User Script: Sync BookOrbit to CrossPoint (Every 15 min)."
else
    echo "Unraid User Scripts not found. Installing into user crontab..."
    (crontab -l 2>/dev/null | grep -v "sync_library.sh" || true; echo "*/15 * * * * ${SYNC_SCRIPT} > /dev/null 2>&1") | crontab -
    echo "Installed cron job to run every 15 minutes."
fi
