const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CAMERA_MESSAGE = "MSTV Visio nécessite l'accès à la caméra pour la visio.";
const MICROPHONE_MESSAGE = "MSTV Visio nécessite l'accès au microphone pour la visio.";

function setPlistValue(plistPath, key, value) {
  execFileSync("/usr/bin/plutil", ["-replace", key, "-string", value, plistPath], {
    stdio: "ignore"
  });
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appRoot = path.join(context.appOutDir, appName, "Contents");
  const plistPaths = [
    path.join(appRoot, "Info.plist"),
    path.join(appRoot, "Frameworks", "MSTV Visio Helper.app", "Contents", "Info.plist"),
    path.join(appRoot, "Frameworks", "MSTV Visio Helper (Renderer).app", "Contents", "Info.plist"),
    path.join(appRoot, "Frameworks", "MSTV Visio Helper (GPU).app", "Contents", "Info.plist"),
    path.join(appRoot, "Frameworks", "MSTV Visio Helper (Plugin).app", "Contents", "Info.plist")
  ];

  for (const plistPath of plistPaths) {
    console.log(`[afterPack] Updating macOS permissions in ${plistPath}`);
    setPlistValue(plistPath, "NSCameraUsageDescription", CAMERA_MESSAGE);
    setPlistValue(plistPath, "NSMicrophoneUsageDescription", MICROPHONE_MESSAGE);
    setPlistValue(plistPath, "CFBundleDisplayName", "MSTV Visio");
  }
};
