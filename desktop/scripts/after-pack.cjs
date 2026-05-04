const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CAMERA_MESSAGE = "MSTV Visio utilise la caméra pour publier les entrées vidéo de régie.";
const MICROPHONE_MESSAGE = "MSTV Visio utilise le micro pour publier les entrées audio de régie.";

function setPlistValue(plistPath, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
      stdio: "ignore"
    });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plistPath], {
      stdio: "ignore"
    });
  }
}

exports.default = async function afterPack(context) {
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
    setPlistValue(plistPath, "NSCameraUsageDescription", CAMERA_MESSAGE);
    setPlistValue(plistPath, "NSMicrophoneUsageDescription", MICROPHONE_MESSAGE);
    setPlistValue(plistPath, "CFBundleDisplayName", "MSTV Visio");
  }
};
