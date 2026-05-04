import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { RoomServiceClient } from "livekit-server-sdk";

const APP_URL = "http://127.0.0.1:3001";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOM = `runtime-proof-${Date.now()}`;

const GUESTS = [
  {
    name: "Alice",
    color: [220, 38, 38],
    tone: 440
  },
  {
    name: "Bruno",
    color: [22, 163, 74],
    tone: 554
  },
  {
    name: "Chloe",
    color: [37, 99, 235],
    tone: 659
  }
];

function loadEnv() {
  return Object.fromEntries(
    readFileSync(".env.local", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nearestGuestByColor(rgb) {
  return GUESTS.map((guest) => ({
    name: guest.name,
    distance: Math.sqrt(
      guest.color.reduce((sum, value, index) => sum + (value - rgb[index]) ** 2, 0)
    )
  })).sort((left, right) => left.distance - right.distance)[0];
}

function nearestGuestByTone(frequency) {
  return GUESTS.map((guest) => ({
    name: guest.name,
    distance: Math.abs(guest.tone - frequency)
  })).sort((left, right) => left.distance - right.distance)[0];
}

async function waitForApp() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(APP_URL);

      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(500);
  }

  throw new Error(`App did not become ready at ${APP_URL}.`);
}

function rgbToYuv([red, green, blue]) {
  return {
    y: Math.max(0, Math.min(255, Math.round(0.257 * red + 0.504 * green + 0.098 * blue + 16))),
    u: Math.max(0, Math.min(255, Math.round(-0.148 * red - 0.291 * green + 0.439 * blue + 128))),
    v: Math.max(0, Math.min(255, Math.round(0.439 * red - 0.368 * green - 0.071 * blue + 128)))
  };
}

function createSolidColorY4m(filePath, rgb) {
  const width = 320;
  const height = 180;
  const frameCount = 30;
  const { y, u, v } = rgbToYuv(rgb);
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`, "ascii");
  const frameHeader = Buffer.from("FRAME\n", "ascii");
  const yPlane = Buffer.alloc(width * height, y);
  const uPlane = Buffer.alloc((width * height) / 4, u);
  const vPlane = Buffer.alloc((width * height) / 4, v);
  const frames = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    frames.push(frameHeader, yPlane, uPlane, vPlane);
  }

  writeFileSync(filePath, Buffer.concat([header, ...frames]));
}

function createSineWaveWav(filePath, frequency) {
  const sampleRate = 48000;
  const durationSeconds = 2;
  const channelCount = 1;
  const bytesPerSample = 2;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate);
    buffer.writeInt16LE(Math.round(sample * 32767 * 0.2), 44 + index * 2);
  }

  writeFileSync(filePath, buffer);
}

function createMediaFixtures() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "visio-mstv-media-"));

  return GUESTS.map((guest) => {
    const videoPath = join(fixtureRoot, `${guest.name.toLowerCase()}.y4m`);
    const audioPath = join(fixtureRoot, `${guest.name.toLowerCase()}.wav`);

    createSolidColorY4m(videoPath, guest.color);
    createSineWaveWav(audioPath, guest.tone);

    return {
      ...guest,
      videoPath,
      audioPath
    };
  });
}

async function joinGuest(page, room, guest) {
  console.log(`guest:${guest.name}:goto`);
  await page.goto(`${APP_URL}/guest/${room}`, {
    waitUntil: "domcontentloaded"
  });
  console.log(`guest:${guest.name}:loaded`);
  await page.type('input[placeholder="Your name"]', guest.name);
  console.log(`guest:${guest.name}:typed`);
  await page.$eval("form", (form) => {
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  });
  console.log(`guest:${guest.name}:submitted`);
  await sleep(8000);
  console.log(`guest:${guest.name}:settled`);
}

async function clickGuestTile(page, guestName) {
  const clicked = await page.evaluate((name) => {
    const candidate = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(name)
    );

    if (!candidate) {
      return false;
    }

    candidate.click();
    return true;
  }, guestName);

  if (!clicked) {
    throw new Error(`Unable to find control tile for ${guestName}.`);
  }
}

async function waitForGuestTiles(page, guestNames) {
  await page.waitForFunction(
    (names) =>
      names.every((name) =>
        [...document.querySelectorAll("button")].some((button) => button.textContent?.includes(name))
      ),
    {
      timeout: 45000
    },
    guestNames
  );
}

async function waitForProgramVideoCount(page, expectedCount) {
  await page.waitForFunction(
    (count) => document.querySelectorAll("video").length === count,
    {
      timeout: 45000
    },
    expectedCount
  );
  await sleep(1500);
}

async function readProgramVideos(page) {
  const videos = await page.evaluate(() => {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 64;
    sampleCanvas.height = 36;
    const context = sampleCanvas.getContext("2d");

    return [...document.querySelectorAll("video")]
      .map((video) => {
        const rect = video.getBoundingClientRect();
        let rgb = [0, 0, 0];

        if (context && video.videoWidth > 0 && video.videoHeight > 0) {
          context.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
          context.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
          const pixel = context.getImageData(
            Math.floor(sampleCanvas.width / 2),
            Math.floor(sampleCanvas.height / 2),
            1,
            1
          ).data;
          rgb = [pixel[0], pixel[1], pixel[2]];
        }

        return {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          rgb
        };
      })
      .sort((left, right) => left.left - right.left);
  });

  return videos.map((video) => ({
    ...video,
    guest: nearestGuestByColor(video.rgb).name
  }));
}

async function readProgramAudio(page) {
  const frequencies = await page.evaluate(async () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const analysisContext = window.__mstvAnalysisContext || new AudioContextCtor();
    window.__mstvAnalysisContext = analysisContext;
    window.__mstvAnalysisNodes ??= new WeakMap();

    await analysisContext.resume();

    const audios = [...document.querySelectorAll("audio")];
    const results = [];

    for (const audio of audios) {
      try {
        await audio.play();
      } catch {}

      let analyser = window.__mstvAnalysisNodes.get(audio);

      if (!analyser) {
        const source = analysisContext.createMediaElementSource(audio);
        analyser = analysisContext.createAnalyser();
        analyser.fftSize = 4096;
        source.connect(analyser);
        analyser.connect(analysisContext.destination);
        window.__mstvAnalysisNodes.set(audio, analyser);
      }

      await new Promise((resolve) => setTimeout(resolve, 400));

      const bins = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(bins);

      let peakIndex = 0;
      let peakValue = -1;

      for (let index = 0; index < bins.length; index += 1) {
        if (bins[index] > peakValue) {
          peakValue = bins[index];
          peakIndex = index;
        }
      }

      results.push((peakIndex * analysisContext.sampleRate) / analyser.fftSize);
    }

    return {
      audioElementCount: audios.length,
      frequencies: results
    };
  });

  return {
    audioElementCount: frequencies.audioElementCount,
    tones: frequencies.frequencies.map((frequency) => ({
      frequency,
      guest: nearestGuestByTone(frequency).name
    }))
  };
}

async function readAudioToneLevels(page) {
  return page.evaluate(async (guests) => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const analysisContext = window.__mstvToneContext || new AudioContextCtor();
    const analyser = window.__mstvToneAnalyser || analysisContext.createAnalyser();
    const mixNode = window.__mstvToneMixNode || analysisContext.createGain();

    analyser.fftSize = 8192;

    if (!window.__mstvToneContext) {
      mixNode.connect(analyser);
      analyser.connect(analysisContext.destination);
      window.__mstvToneContext = analysisContext;
      window.__mstvToneAnalyser = analyser;
      window.__mstvToneMixNode = mixNode;
      window.__mstvToneSources = new WeakMap();
    }

    await analysisContext.resume();

    const audios = [...document.querySelectorAll("audio")];

    for (const audio of audios) {
      try {
        await audio.play();
      } catch {}

      if (!window.__mstvToneSources.get(audio)) {
        const source = analysisContext.createMediaElementSource(audio);
        source.connect(mixNode);
        window.__mstvToneSources.set(audio, source);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));

    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);

    const levels = Object.fromEntries(
      guests.map((guest) => {
        const binIndex = Math.round((guest.tone * analyser.fftSize) / analysisContext.sampleRate);
        const level = Math.max(
          bins[Math.max(0, binIndex - 2)] ?? 0,
          bins[Math.max(0, binIndex - 1)] ?? 0,
          bins[binIndex] ?? 0,
          bins[Math.min(bins.length - 1, binIndex + 1)] ?? 0,
          bins[Math.min(bins.length - 1, binIndex + 2)] ?? 0
        );

        return [guest.name, level];
      })
    );

    return {
      audioElementCount: audios.length,
      levels
    };
  }, GUESTS);
}

async function readGuestProgramReturn(page, layoutSize) {
  const result = await page.evaluate((expectedSlots) => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 120;
    sampleCanvas.height = 68;
    const context = sampleCanvas.getContext("2d");
    const largestVideo = [...document.querySelectorAll("video")]
      .map((video) => {
        const rect = video.getBoundingClientRect();

        return {
          video,
          rect,
          area: rect.width * rect.height
        };
      })
      .sort((left, right) => right.area - left.area)[0];

    let samples = [];

    if (largestVideo && context && largestVideo.video.videoWidth > 0 && largestVideo.video.videoHeight > 0) {
      context.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      context.drawImage(largestVideo.video, 0, 0, sampleCanvas.width, sampleCanvas.height);

      const sampleRatios =
        expectedSlots <= 1
          ? [0.5]
          : expectedSlots === 2
            ? [0.25, 0.75]
            : [1 / 6, 0.5, 5 / 6];

      samples = sampleRatios.map((ratio) => {
        const pixel = context.getImageData(
          Math.floor(sampleCanvas.width * ratio),
          Math.floor(sampleCanvas.height / 2),
          1,
          1
        ).data;

        return [pixel[0], pixel[1], pixel[2]];
      });
    }

    return {
      videoCount: document.querySelectorAll("video").length,
      audioCount: document.querySelectorAll("audio").length,
      largeVideoCount: [...document.querySelectorAll("video")].filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > viewportWidth * 0.6 && rect.height > viewportHeight * 0.45;
      }).length,
      largeVideoSamples: samples,
      text: document.body.innerText
    };
  }, layoutSize);

  const toneLevels = await readAudioToneLevels(page);

  return {
    ...result,
    largeVideoGuests: result.largeVideoSamples.map((rgb) => nearestGuestByColor(rgb).name),
    toneLevels
  };
}

async function listRoomParticipants(roomService, roomName) {
  const participants = await roomService.listParticipants(roomName);

  return participants.map((participant) => ({
    identity: participant.identity,
    name: participant.name,
    tracks: participant.tracks.map((track) => ({
      source: track.source,
      muted: track.muted
    }))
  }));
}

async function main() {
  await waitForApp();
  console.log("app-ready");

  const env = loadEnv();
  const fixtures = createMediaFixtures();
  const roomService = new RoomServiceClient(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET
  );

  const monitorBrowser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    ignoreDefaultArgs: ["--mute-audio"],
    args: ["--autoplay-policy=no-user-gesture-required"]
  });

  const guestBrowsers = await Promise.all(
    fixtures.map((fixture) =>
      puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: "new",
        ignoreDefaultArgs: ["--mute-audio"],
        args: [
          "--autoplay-policy=no-user-gesture-required",
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          `--use-file-for-fake-video-capture=${fixture.videoPath}`,
          `--use-file-for-fake-audio-capture=${fixture.audioPath}`
        ]
      })
    )
  );

  const controlPage = await monitorBrowser.newPage();
  const programPage = await monitorBrowser.newPage();
  const guestPages = await Promise.all(guestBrowsers.map((browser) => browser.newPage()));

  const report = {
    room: ROOM
  };

  try {
    console.log("browsers-launched");
    await Promise.all([
      controlPage.goto(`${APP_URL}/control/${ROOM}`, { waitUntil: "domcontentloaded" }),
      programPage.goto(`${APP_URL}/program/${ROOM}`, { waitUntil: "domcontentloaded" })
    ]);
    console.log("control-and-program-loaded");

    for (const [index, page] of guestPages.entries()) {
      await joinGuest(page, ROOM, fixtures[index]);
    }

    console.log("guests-joined");
    await waitForGuestTiles(
      controlPage,
      fixtures.map((guest) => guest.name)
    );
    console.log("guest-tiles-visible");

    report.roomsAfterJoin = {
      contribution: await listRoomParticipants(roomService, `${ROOM}--contribution`),
      program: await listRoomParticipants(roomService, `${ROOM}--program`)
    };

    await clickGuestTile(controlPage, "Alice");
    await waitForProgramVideoCount(programPage, 1);
    console.log("one-guest-selected");

    report.oneGuest = {
      programVideos: await readProgramVideos(programPage),
      programAudio: await readProgramAudio(programPage),
      guestReturn: await readGuestProgramReturn(guestPages[0], 1)
    };

    await clickGuestTile(controlPage, "Alice");
    await waitForProgramVideoCount(programPage, 0);
    console.log("scene-cleared-after-one");

    report.afterDeselect = {
      programVideos: await readProgramVideos(programPage),
      programAudio: await readProgramAudio(programPage),
      guestReturn: await readGuestProgramReturn(guestPages[0], 1)
    };

    await clickGuestTile(controlPage, "Bruno");
    await clickGuestTile(controlPage, "Alice");
    await waitForProgramVideoCount(programPage, 2);
    console.log("two-guests-selected");

    report.twoGuests = {
      programVideos: await readProgramVideos(programPage),
      programAudio: await readProgramAudio(programPage),
      guestReturn: await readGuestProgramReturn(guestPages[0], 2)
    };

    await clickGuestTile(controlPage, "Bruno");
    await clickGuestTile(controlPage, "Alice");
    await waitForProgramVideoCount(programPage, 0);
    console.log("scene-cleared-after-two");

    await clickGuestTile(controlPage, "Chloe");
    await clickGuestTile(controlPage, "Alice");
    await clickGuestTile(controlPage, "Bruno");
    await waitForProgramVideoCount(programPage, 3);
    console.log("three-guests-selected");

    report.threeGuests = {
      programVideos: await readProgramVideos(programPage),
      programAudio: await readProgramAudio(programPage),
      guestReturn: await readGuestProgramReturn(guestPages[0], 3)
    };

    report.roomsFinal = {
      contribution: await listRoomParticipants(roomService, `${ROOM}--contribution`),
      program: await listRoomParticipants(roomService, `${ROOM}--program`)
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.all(guestBrowsers.map((browser) => browser.close().catch(() => undefined)));
    await monitorBrowser.close().catch(() => undefined);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
