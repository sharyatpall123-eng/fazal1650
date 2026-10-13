import { supabaseAdmin } from "../config/supabase.js";



import "../config/env.js";



import fs from "node:fs";



import path from "node:path";







import pkg from "whatsapp-web.js";







import {



  createPaymentReceiptPng,



  createWeeklyDebtReportPng,



  createFullAccountReportPdf,

  setSharedPuppeteerBrowserProvider,



} from "./reportImageService.js";







const {



  Client,



  LocalAuth,



  MessageMedia,



} = pkg;







/* =========================================



   WHATSAPP WEB CLIENT



========================================= */







let whatsappReady = false;



let whatsappInitializing = false;



let authenticatedAt = null;



let connectionCheckTimer = null;



/* =========================================

   AZI WHATSAPP AUTO-RECONNECT V2

========================================= */



let reconnectTimer = null;

let reconnectRunning = false;

let reconnectAttempt = 0;



let healthTimer = null;

let healthFails = 0;

let watchedWhatsAppBrowser = null;

let whatsappPairingRequired = false;



/*
  Hostinger can briefly overlap old/new Node processes during
  deploys/restarts. Only one process may own the LocalAuth
  Chromium profile at a time.
*/
let whatsappProcessLockOwned = false;
let whatsappProcessLockHeartbeatTimer = null;
let whatsappProcessLockBlocked = false;
let whatsappShuttingDown = false;
let lastOwnerLockLogAt = 0;
let lastInitializeNeedsCooldown = false;

const WHATSAPP_PROCESS_INSTANCE_ID =
  `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;



const RECONNECT_BASE_MS = 5_000;

const RECONNECT_MAX_MS = 60_000;

const HEALTH_CHECK_MS = 20_000;

const HEALTH_FAIL_LIMIT = 2;

const WHATSAPP_OWNER_LOCK_RETRY_MS = 10_000;
const WHATSAPP_OWNER_LOCK_STALE_MS = 45_000;
const WHATSAPP_OWNER_LOCK_HEARTBEAT_MS = 5_000;
const WHATSAPP_BROWSER_CONFLICT_RETRY_MS = 20_000;
const WHATSAPP_BROWSER_RELEASE_WAIT_MS = 5_000;



function clearReconnectTimer() {

  if (reconnectTimer) {

    clearTimeout(

      reconnectTimer

    );



    reconnectTimer = null;

  }

}



function getReconnectDelay() {

  const delay =

    RECONNECT_BASE_MS *

    Math.pow(

      2,

      Math.min(

        reconnectAttempt,

        4

      )

    );



  return Math.min(

    delay,

    RECONNECT_MAX_MS

  );

}



function scheduleWhatsAppReconnect(

  reason = "unknown",
  forcedDelayMs = null

) {

  /*

    Avoid opening multiple Chromium

    processes at the same time.

  */

  if (

    whatsappShuttingDown ||

    whatsappReady ||

    whatsappInitializing ||

    reconnectRunning ||

    reconnectTimer

  ) {

    return;

  }



  const delay =
    Number.isFinite(Number(forcedDelayMs)) &&
    Number(forcedDelayMs) >= 0
      ? Number(forcedDelayMs)
      : getReconnectDelay();



  setWhatsAppConnectionState(

    "RECOVERING"

  );



  console.warn(

    `🔄 WhatsApp reconnect scheduled in ${Math.round(

      delay / 1000

    )}s. Reason: ${reason}`

  );



  reconnectTimer =

    setTimeout(

      async () => {
        reconnectTimer = null;

        if (
          whatsappReady ||
          whatsappPairingRequired
        ) {
          return;
        }



        reconnectAttempt += 1;



        await reconnectWhatsApp(
          reason
        );
      },

      delay

    );



  reconnectTimer.unref?.();

}



async function reconnectWhatsApp(

  reason = "unknown"

) {
  if (
    whatsappShuttingDown ||
    reconnectRunning ||
    whatsappReady ||
    whatsappPairingRequired
  ) {
    return;
  }



  reconnectRunning = true;



  whatsappReady = false;
  whatsappInitializing = false;



  setWhatsAppConnectionState(
    "RECOVERING"
  );



  stopConnectionChecker();



  console.warn(
    `♻️ Recovering WhatsApp Web. Reason: ${reason}`
  );



  /*
    Close only Chromium/client.
    LocalAuth session files are NOT deleted.
  */
  try {
    await whatsappClient
      .destroy()
      .catch(() => {});
  } catch {
    // Browser/client may already be closed.
  }



  /*
    Give Hostinger/Chromium time to release
    memory, processes and lock files.
  */
  await new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        WHATSAPP_BROWSER_RELEASE_WAIT_MS
      );
    }
  );

  resetWhatsAppClientRuntimeReferences();



  let initializedSuccessfully = false;



  try {
    initializedSuccessfully =
      await initializeWhatsApp();
  } catch (error) {
    console.error(
      "❌ WhatsApp recovery error:",
      error?.message || error
    );



    whatsappReady = false;
    whatsappInitializing = false;
  } finally {
    reconnectRunning = false;
  }



  if (whatsappReady) {
    return;
  }



  /*
    If WhatsApp generated a QR, the saved
    session is no longer usable. Do not keep
    restarting Chromium while waiting for scan.
  */
  if (whatsappPairingRequired) {
    console.warn(
      "📱 WhatsApp pairing is required. Waiting for QR scan."
    );

    return;
  }



  /*
    initialize() can fail before ready/authenticated
    events fire. Schedule another clean recovery.
  */
  if (!initializedSuccessfully) {
    const retryDelay = whatsappProcessLockBlocked
      ? WHATSAPP_OWNER_LOCK_RETRY_MS
      : lastInitializeNeedsCooldown
        ? WHATSAPP_BROWSER_CONFLICT_RETRY_MS
        : null;

    scheduleWhatsAppReconnect(
      whatsappProcessLockBlocked
        ? "waiting for previous Hostinger WhatsApp process to stop"
        : "recovery initialize failed",
      retryDelay
    );

    return;
  }



  /*
    Chromium started successfully but WhatsApp
    may still need a few seconds to reach CONNECTED.
  */
  startConnectionChecker();
}



let detachedFrameRecoveryPromise = null;







// Latest WhatsApp pairing QR is kept only in server memory.



// It is never written to Supabase, disk, or Git.



const WHATSAPP_QR_TTL_MS = 60_000;



let latestQrDataUrl = null;



let latestQrGeneratedAt = null;



let whatsappConnectionState = "STARTING";



let qrGenerationVersion = 0;







function clearWhatsAppQr() {



  qrGenerationVersion += 1;



  latestQrDataUrl = null;



  latestQrGeneratedAt = null;



}







function setWhatsAppConnectionState(state) {



  whatsappConnectionState = String(state || "UNKNOWN");



}







function findInstalledChrome() {

  const candidates = [

    process.env.WHATSAPP_CHROME_PATH,

    process.env.PUPPETEER_EXECUTABLE_PATH,

    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\\Google\\\Chrome\\\Application\\\chrome.exe`,

    process.env["PROGRAMFILES(X86)"] && `${process.env["PROGRAMFILES(X86)"]}\\\Google\\\Chrome\\\Application\\\chrome.exe`,

    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\\Google\\\Chrome\\\Application\\\chrome.exe`,

    "/usr/bin/google-chrome",

    "/usr/bin/google-chrome-stable",

    "/usr/bin/chromium",

    "/usr/bin/chromium-browser",

  ].filter(Boolean);



  return candidates.find((candidate) => fs.existsSync(candidate)) || undefined;

}



const installedChromePath = findInstalledChrome();



function resolveWhatsAppAuthPath() {

  const fromEnv =

    String(process.env.WHATSAPP_AUTH_PATH || "").trim();



  if (fromEnv) {

    return path.resolve(fromEnv);

  }



  const cwd = process.cwd();



  // Hostinger deploy folders live under:

  // .../domains/<domain>/hbuilds/versions/<version>/nodejs

  // Store WhatsApp auth outside hbuilds so it survives deploys/restarts.

  const hbuildMarker = `${path.sep}hbuilds${path.sep}`;

  const hbuildIndex = cwd.indexOf(hbuildMarker);



  if (hbuildIndex >= 0) {

    const domainRoot = cwd.slice(0, hbuildIndex);

    return path.join(

      domainRoot,

      ".fazal-wms-whatsapp-auth"

    );

  }



  return path.resolve(

    cwd,

    ".wwebjs_auth_fazal"

  );

}



const WHATSAPP_AUTH_PATH =

  resolveWhatsAppAuthPath();



fs.mkdirSync(

  WHATSAPP_AUTH_PATH,

  { recursive: true }

);



const WHATSAPP_OWNER_LOCK_PATH = path.join(
  WHATSAPP_AUTH_PATH,
  ".azi-wms-whatsapp-owner.lock"
);

const WHATSAPP_SESSION_PATH = path.join(
  WHATSAPP_AUTH_PATH,
  "session-azi-wms"
);

const WHATSAPP_CHROMIUM_RUNTIME_FILES = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "DevToolsActivePort",
];



function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}



function readWhatsAppOwnerLock() {
  try {
    const raw = fs.readFileSync(
      WHATSAPP_OWNER_LOCK_PATH,
      "utf8"
    );

    const data = JSON.parse(raw || "{}");
    const stat = fs.statSync(
      WHATSAPP_OWNER_LOCK_PATH
    );

    return {
      pid: Number(data?.pid) || null,
      instanceId:
        String(data?.instanceId || "") || null,
      updatedAt:
        data?.updatedAt ||
        stat.mtime.toISOString(),
      ageMs:
        Date.now() -
        stat.mtimeMs,
    };
  } catch {
    return null;
  }
}



function writeWhatsAppOwnerLock() {
  const payload = JSON.stringify({
    pid: process.pid,
    instanceId: WHATSAPP_PROCESS_INSTANCE_ID,
    updatedAt: new Date().toISOString(),
  });

  fs.writeFileSync(
    WHATSAPP_OWNER_LOCK_PATH,
    payload,
    "utf8"
  );
}



function startWhatsAppOwnerLockHeartbeat() {
  if (
    whatsappProcessLockHeartbeatTimer ||
    !whatsappProcessLockOwned
  ) {
    return;
  }

  whatsappProcessLockHeartbeatTimer =
    setInterval(
      () => {
        if (!whatsappProcessLockOwned) {
          return;
        }

        try {
          const current =
            readWhatsAppOwnerLock();

          if (
            current &&
            current.instanceId !==
              WHATSAPP_PROCESS_INSTANCE_ID
          ) {
            whatsappProcessLockOwned = false;
            whatsappProcessLockBlocked = true;

            clearInterval(
              whatsappProcessLockHeartbeatTimer
            );

            whatsappProcessLockHeartbeatTimer = null;

            console.error(
              "❌ WhatsApp owner lock changed to another process. This process will stop using Chromium."
            );

            return;
          }

          writeWhatsAppOwnerLock();
        } catch (error) {
          console.warn(
            "⚠️ WhatsApp owner lock heartbeat failed:",
            error?.message || error
          );
        }
      },
      WHATSAPP_OWNER_LOCK_HEARTBEAT_MS
    );

  whatsappProcessLockHeartbeatTimer.unref?.();
}



function tryAcquireWhatsAppProcessLock() {
  if (whatsappProcessLockOwned) {
    whatsappProcessLockBlocked = false;
    return true;
  }

  try {
    const fd = fs.openSync(
      WHATSAPP_OWNER_LOCK_PATH,
      "wx"
    );

    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        instanceId: WHATSAPP_PROCESS_INSTANCE_ID,
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    fs.closeSync(fd);

    whatsappProcessLockOwned = true;
    whatsappProcessLockBlocked = false;

    startWhatsAppOwnerLockHeartbeat();

    console.log(
      `🔒 WhatsApp process lock acquired by PID ${process.pid}`
    );

    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      console.warn(
        "⚠️ Could not acquire WhatsApp process lock:",
        error?.message || error
      );

      whatsappProcessLockBlocked = true;
      return false;
    }
  }

  const current =
    readWhatsAppOwnerLock();

  if (
    current?.instanceId ===
    WHATSAPP_PROCESS_INSTANCE_ID
  ) {
    whatsappProcessLockOwned = true;
    whatsappProcessLockBlocked = false;

    startWhatsAppOwnerLockHeartbeat();

    return true;
  }

  /*
    PIDs can be reused after a Hostinger restart.
    A lock with our PID but a different instanceId
    belongs to an older process instance and must
    never be mistaken for this process.
  */
  const samePidDifferentInstance =
    current?.pid === process.pid &&
    current?.instanceId !==
      WHATSAPP_PROCESS_INSTANCE_ID;

  const ownerIsRunning =
    current?.pid &&
    !samePidDifferentInstance
      ? isPidRunning(current.pid)
      : false;

  const lockIsFresh =
    !samePidDifferentInstance &&
    Number(current?.ageMs) <
      WHATSAPP_OWNER_LOCK_STALE_MS;

  if (
    ownerIsRunning ||
    lockIsFresh
  ) {
    whatsappProcessLockBlocked = true;

    if (
      Date.now() - lastOwnerLockLogAt >
      30_000
    ) {
      lastOwnerLockLogAt = Date.now();

      console.warn(
        `⏳ WhatsApp Chromium owner is another process${current?.pid ? ` (owner PID ${current.pid})` : ""}; current PID ${process.pid}. Waiting before retry...`
      );
    }

    return false;
  }

  /*
    The lock is stale and the recorded owner process
    is no longer alive. Remove only our small owner-lock
    file. LocalAuth/session files are never deleted.
  */
  try {
    fs.unlinkSync(
      WHATSAPP_OWNER_LOCK_PATH
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        "⚠️ Could not remove stale WhatsApp owner lock:",
        error?.message || error
      );

      whatsappProcessLockBlocked = true;
      return false;
    }
  }

  try {
    const fd = fs.openSync(
      WHATSAPP_OWNER_LOCK_PATH,
      "wx"
    );

    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        instanceId: WHATSAPP_PROCESS_INSTANCE_ID,
        updatedAt: new Date().toISOString(),
      }),
      "utf8"
    );

    fs.closeSync(fd);

    whatsappProcessLockOwned = true;
    whatsappProcessLockBlocked = false;

    startWhatsAppOwnerLockHeartbeat();

    console.log(
      `🔒 Stale WhatsApp process lock recovered by PID ${process.pid}`
    );

    return true;
  } catch {
    whatsappProcessLockBlocked = true;
    return false;
  }
}




function resetWhatsAppClientRuntimeReferences() {
  try {
    const browser =
      whatsappClient?.pupBrowser || null;

    const browserConnected =
      browser &&
      (typeof browser.isConnected === "function"
        ? browser.isConnected()
        : Boolean(browser.connected));

    if (!browserConnected) {
      whatsappClient.pupBrowser = null;
      whatsappClient.pupPage = null;
    }

    if (
      whatsappClient?.options?.puppeteer
    ) {
      /*
        LocalAuth will restore the correct persistent
        session directory before the next browser launch.
        Clearing this runtime option avoids carrying stale
        Puppeteer launch state across destroy/crash cycles.
      */
      whatsappClient.options.puppeteer.userDataDir =
        undefined;
    }
  } catch {
    // Best-effort runtime cleanup only.
  }
}



function readWhatsAppChromiumProfilePid() {
  if (!IS_LINUX_SERVER) {
    return null;
  }

  const singletonLock = path.join(
    WHATSAPP_SESSION_PATH,
    "SingletonLock"
  );

  try {
    const stat = fs.lstatSync(singletonLock);

    let raw = "";

    if (stat.isSymbolicLink()) {
      raw = fs.readlinkSync(singletonLock);
    } else {
      raw = fs.readFileSync(
        singletonLock,
        "utf8"
      );
    }

    const matches =
      String(raw || "").match(/(\d+)\s*$/);

    return matches
      ? Number(matches[1])
      : null;
  } catch {
    return null;
  }
}



function getLinuxProcessCommandLine(pid) {
  if (
    !IS_LINUX_SERVER ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return "";
  }

  try {
    return fs
      .readFileSync(
        `/proc/${pid}/cmdline`,
        "utf8"
      )
      .replace(/\0/g, " ");
  } catch {
    return "";
  }
}



function isWhatsAppProfileChromiumProcess(pid) {
  const commandLine =
    getLinuxProcessCommandLine(pid);

  if (!commandLine) {
    return false;
  }

  return (
    /(chrome|chromium)/i.test(commandLine) &&
    commandLine.includes(WHATSAPP_SESSION_PATH)
  );
}



function removeWhatsAppChromiumRuntimeFiles() {
  for (
    const fileName of
    WHATSAPP_CHROMIUM_RUNTIME_FILES
  ) {
    const target = path.join(
      WHATSAPP_SESSION_PATH,
      fileName
    );

    try {
      fs.unlinkSync(target);
    } catch (error) {
      if (
        error?.code !== "ENOENT"
      ) {
        console.warn(
          `⚠️ Could not remove stale Chromium runtime file ${fileName}:`,
          error?.message || error
        );
      }
    }
  }
}



async function waitForPidToExit(
  pid,
  timeoutMs = 2500
) {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    if (!isPidRunning(pid)) {
      return true;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 250)
    );
  }

  return !isPidRunning(pid);
}



async function cleanupStaleWhatsAppChromiumProfile() {
  if (!IS_LINUX_SERVER) {
    resetWhatsAppClientRuntimeReferences();
    return true;
  }

  fs.mkdirSync(
    WHATSAPP_SESSION_PATH,
    { recursive: true }
  );

  const browserPid =
    readWhatsAppChromiumProfilePid();

  if (
    browserPid &&
    isPidRunning(browserPid)
  ) {
    /*
      We hold the AZI process-owner lock here, so another
      live Node process is not allowed to own this profile.
      Kill only a process we can positively identify as
      Chromium using this exact WhatsApp session directory.
    */
    if (
      !isWhatsAppProfileChromiumProcess(
        browserPid
      )
    ) {
      console.warn(
        `⏳ WhatsApp profile is locked by live PID ${browserPid}, but it could not be verified as our Chromium process. Waiting instead of deleting its lock.`
      );

      return false;
    }

    console.warn(
      `🧹 Stopping orphan WhatsApp Chromium PID ${browserPid} before reconnect...`
    );

    try {
      process.kill(
        browserPid,
        "SIGTERM"
      );
    } catch {
      // It may have exited between the checks.
    }

    let exited =
      await waitForPidToExit(
        browserPid,
        2500
      );

    if (
      !exited &&
      isWhatsAppProfileChromiumProcess(
        browserPid
      )
    ) {
      try {
        process.kill(
          browserPid,
          "SIGKILL"
        );
      } catch {
        // It may have exited already.
      }

      exited =
        await waitForPidToExit(
          browserPid,
          1000
        );
    }

    if (!exited) {
      console.warn(
        `⏳ WhatsApp Chromium PID ${browserPid} is still alive. Delaying reconnect to avoid profile corruption.`
      );

      return false;
    }
  }

  /*
    Chromium is confirmed gone. These files are runtime
    locks/endpoint metadata only; they do not contain the
    WhatsApp LocalAuth login session.
  */
  removeWhatsAppChromiumRuntimeFiles();
  resetWhatsAppClientRuntimeReferences();

  return true;
}



function releaseWhatsAppProcessLock() {
  if (
    whatsappProcessLockHeartbeatTimer
  ) {
    clearInterval(
      whatsappProcessLockHeartbeatTimer
    );

    whatsappProcessLockHeartbeatTimer = null;
  }

  if (!whatsappProcessLockOwned) {
    return;
  }

  try {
    const current =
      readWhatsAppOwnerLock();

    if (
      current?.instanceId ===
      WHATSAPP_PROCESS_INSTANCE_ID
    ) {
      fs.unlinkSync(
        WHATSAPP_OWNER_LOCK_PATH
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(
        "⚠️ Could not release WhatsApp process lock:",
        error?.message || error
      );
    }
  } finally {
    whatsappProcessLockOwned = false;
  }
}



function prepareWhatsAppForSigterm() {
  if (whatsappShuttingDown) {
    return;
  }

  whatsappShuttingDown = true;

  clearReconnectTimer();
  stopConnectionChecker();

  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }

  console.log(
    "🛑 WhatsApp preparing for SIGTERM shutdown..."
  );

  /*
    Send Chromium a termination signal immediately.
    server.js remains responsible for the app/server exit.
  */
  try {
    const browserProcess =
      whatsappClient?.pupBrowser
        ?.process?.();

    if (
      browserProcess &&
      !browserProcess.killed
    ) {
      browserProcess.kill("SIGTERM");
    }
  } catch {
    // Browser may already be gone.
  }

  /*
    This process will not touch Chromium again after SIGTERM.
    Release only the AZI owner lock so the replacement process
    can take over; it will still verify/clean the Chromium
    profile runtime lock before launching.
  */
  releaseWhatsAppProcessLock();
}



process.prependListener(
  "SIGTERM",
  prepareWhatsAppForSigterm
);

process.on(
  "exit",
  releaseWhatsAppProcessLock
);



const IS_LINUX_SERVER = process.platform === "linux";


/* =========================================
   WHATSAPP-WEB.JS HOSTINGER BOOTSTRAP GUARD
========================================= */

function withHardTimeout(task, timeoutMs, message) {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve().then(task),
    timeoutPromise,
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}


const originalWhatsAppInject = Client.prototype.inject;
const originalInitWebVersionCache = Client.prototype.initWebVersionCache;

if (IS_LINUX_SERVER) {
  /*
    whatsapp-web.js 1.x can attach a response listener that calls res.text()
    for the WhatsApp Web root document. Chromium may surface an OPTIONS /
    preflight response with the same URL, and Puppeteer cannot read a body
    from that response. On Hostinger we do not need to capture/persist the
    index HTML, so skip this cache-capture hook and let WhatsApp Web load
    normally from the network.
  */
  Client.prototype.initWebVersionCache = async function aziSafeWebVersionCache() {
    console.log("🧪 WhatsApp init stage: web-version-cache");
    this.currentIndexHtml = null;

    /*
      whatsapp-web.js currently navigates to web.whatsapp.com with
      waitUntil: "load" and timeout: 0. If the full load event never settles
      on a constrained host, initialize() can wait forever before inject()
      gets a chance to run.

      Patch only this WhatsApp page instance so its navigation completes on
      DOMContentLoaded and has a real timeout. The injection guard below then
      waits for WhatsApp's module loader before continuing.
    */
    const page = this.pupPage;

    if (page && !page.__aziWhatsAppNavigationGuard) {
      const originalGoto = page.goto.bind(page);

      page.goto = async (url, options = {}) => {
        const targetUrl = String(url || "");

        if (/^https:\/\/web\.whatsapp\.com\/?/i.test(targetUrl)) {
          console.log("🧪 WhatsApp init stage: navigation-start");

          const response = await withHardTimeout(
            () =>
              originalGoto(url, {
                ...options,
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              }),
            65_000,
            "WhatsApp Web navigation hard timeout after 65 seconds"
          );

          console.log("🧪 WhatsApp init stage: navigation-finished");
          return response;
        }

        return originalGoto(url, options);
      };

      page.__aziWhatsAppNavigationGuard = true;
    }
  };

  /*
    On a cold Chromium start window.Debug can exist before WhatsApp's module
    loader is callable. whatsapp-web.js 1.x immediately calls window.require()
    during inject(), which can throw "window.require is not a function".
    Wait for the actual module loader before allowing the original injection.
  */
  Client.prototype.inject = async function aziSafeInject(...args) {
    console.log("🧪 WhatsApp init stage: inject-start");
    const page = this.pupPage;

    if (page && !page.isClosed()) {
      try {
        await page.waitForFunction(
          () =>
            typeof window.require === "function" &&
            typeof window.Debug?.VERSION !== "undefined",
          {
            timeout: 60_000,
            polling: 250,
          }
        );

        console.log("🧪 WhatsApp init stage: module-loader-ready");
      } catch (error) {
        let pageUrl = "unknown";

        try {
          pageUrl = page.url();
        } catch {
          // Ignore diagnostic URL failure.
        }

        throw new Error(
          `WhatsApp Web module loader was not ready before injection (${pageUrl}): ${error?.message || error}`
        );
      }
    }

    return originalWhatsAppInject.apply(this, args);
  };
}



console.log("🔐 WhatsApp auth storage:", WHATSAPP_AUTH_PATH);



if (installedChromePath) {

  console.log("✅ WhatsApp will use Chrome:", installedChromePath);

} else {

  console.log("ℹ️ Installed Google Chrome was not found; Puppeteer browser will be used.");

}



const puppeteerArgs = [

  "--no-sandbox",

  "--disable-setuid-sandbox",

  "--disable-dev-shm-usage",

  "--no-first-run",

  "--no-default-browser-check",

  "--disable-gpu",

  "--disable-extensions",

  "--disable-background-networking",

  "--disable-background-timer-throttling",

  "--disable-renderer-backgrounding",

  "--disable-sync",

  "--metrics-recording-only",

  "--mute-audio",

  "--no-service-autorun",

  "--disable-crash-reporter",

  "--disable-breakpad",

  "--disable-features=Crashpad",

];



// Hostinger shared hosting can have a very small process/thread allowance.

// These Linux-only flags reduce Chromium process usage without forcing
// --single-process is intentionally not used. Modern Chromium can become
// unstable when process creation is over-constrained. Keep --no-zygote for
// Hostinger, but let Chromium manage renderer processes automatically.

if (IS_LINUX_SERVER) {

  puppeteerArgs.push(

    "--no-zygote"

  );

}



console.log("🟢 WhatsApp Hostinger low-resource mode: V3");

console.log("💾 WhatsApp persistent auth path fix: V2");

console.log("🛠️ WhatsApp detached-frame recovery: V1");
console.log("🔁 WhatsApp fast auto-reconnect: V4");
console.log("🔒 WhatsApp single-process Chromium guard: V3");
console.log("🌐 WhatsApp Puppeteer transport: PIPE V1");
console.log("🧩 WhatsApp injection readiness guard: V1");
console.log("🛡️ WhatsApp web-cache preflight guard: V1");
console.log("🧭 WhatsApp navigation timeout guard: V1");
console.log("🧪 WhatsApp initialize diagnostics: V1");
console.log("🌐 WhatsApp host network probe: V1");
console.log("⏱️ WhatsApp hard navigation timeout: V1");
console.log("🔐 WhatsApp auth/socket timeout: V1 (120s)");



const whatsappClient = new Client({



  // Match the real Windows Chrome environment that already works with WhatsApp Web.



  userAgent:



    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",



  // whatsapp-web.js uses authTimeoutMs while waiting for the WhatsApp
  // socket to leave OPENING / UNLAUNCHED / PAIRING. Hostinger can need
  // longer than the library default of 30 seconds after a cold start.
  authTimeoutMs: 120_000,







  authStrategy: new LocalAuth({



    clientId: "fazal-wms",



    dataPath: WHATSAPP_AUTH_PATH,



    rmMaxRetries: 8,



  }),







  puppeteer: {



    headless: true,



    ...(installedChromePath ? { executablePath: installedChromePath } : {}),



    protocolTimeout: 180000,



    // On Linux/Hostinger use an OS pipe instead of a temporary localhost
    // DevTools WebSocket port. This avoids ECONNREFUSED 127.0.0.1:<port>
    // when Chromium starts but the transient debugging socket is not usable.
    pipe: IS_LINUX_SERVER,



    timeout: 180000,



    defaultViewport: null,



    args: puppeteerArgs,



  },



});



// Reuse the Chromium instance already opened by whatsapp-web.js when

// reportImageService creates receipt/weekly-report images or PDFs.

// This prevents a second Chrome launch on low-resource Hostinger hosting.

setSharedPuppeteerBrowserProvider(

  () => whatsappClient.pupBrowser || null

);



console.log("♻️ Report renderer will reuse the WhatsApp Chromium browser.");







/* =========================================



   CONNECTION HELPERS



========================================= */







function stopConnectionChecker() {



  if (connectionCheckTimer) {



    clearInterval(connectionCheckTimer);



    connectionCheckTimer = null;



  }



}



function attachWhatsAppBrowserCrashWatcher() {
  const browser = whatsappClient.pupBrowser;



  if (
    !browser ||
    browser === watchedWhatsAppBrowser
  ) {
    return;
  }



  watchedWhatsAppBrowser = browser;



  browser.once(
    "disconnected",
    () => {
      if (watchedWhatsAppBrowser === browser) {
        watchedWhatsAppBrowser = null;
      }



      /*
        reconnectWhatsApp() intentionally destroys
        Chromium before starting it again. Do not
        start a second recovery for that close.
      */
      if (
        whatsappShuttingDown ||
        reconnectRunning ||
        whatsappPairingRequired
      ) {
        return;
      }



      whatsappReady = false;
      whatsappInitializing = false;



      setWhatsAppConnectionState(
        "BROWSER_DISCONNECTED"
      );



      stopConnectionChecker();



      console.error(
        "💥 WhatsApp Chromium disconnected. Automatic recovery starting..."
      );



      scheduleWhatsAppReconnect(
        "Chromium browser disconnected"
      );
    }
  );
}



function markWhatsAppReady(

  source = "ready"

) {

  setWhatsAppConnectionState(

    "CONNECTED"

  );



  clearWhatsAppQr();



  const wasReady =

    whatsappReady;



  whatsappReady = true;
  whatsappInitializing = false;
  whatsappPairingRequired = false;



  attachWhatsAppBrowserCrashWatcher();



  reconnectAttempt = 0;
  healthFails = 0;



  stopConnectionChecker();

  clearReconnectTimer();



  if (wasReady) {

    return;

  }



  console.log("");

  console.log(

    "========================================="

  );

  console.log(

    "✅ AZI WMS WhatsApp Web connected"

  );

  console.log(

    `Connection confirmed by: ${source}`

  );

  console.log(

    "========================================="

  );

  console.log("");

}







async function verifyWhatsAppConnection() {



  try {
    const browser =
      whatsappClient?.pupBrowser || null;

    const page =
      whatsappClient?.pupPage || null;

    const browserConnected =
      browser &&
      (typeof browser.isConnected === "function"
        ? browser.isConnected()
        : Boolean(browser.connected));

    if (
      !browserConnected ||
      !page ||
      (typeof page.isClosed === "function" &&
        page.isClosed())
    ) {
      return false;
    }



    const runtimeReady = await page.evaluate(() => {
      return (
        typeof window.require === "function" &&
        typeof window.Debug?.VERSION !== "undefined"
      );
    });

    if (!runtimeReady) {
      return false;
    }

    const state = await whatsappClient.getState();







    setWhatsAppConnectionState(state || "UNKNOWN");







    console.log(



      "🔎 WhatsApp connection state:",



      state || "UNKNOWN"



    );







    if (state === "CONNECTED") {



      markWhatsAppReady(



        "getState CONNECTED"



      );







      return true;



    }







    return false;



  } catch (error) {



    console.log(



      "⏳ WhatsApp state not ready yet:",



      error?.message || error



    );







    return false;



  }



}







function startConnectionChecker() {



  if (connectionCheckTimer) return;







  let attempts = 0;







  connectionCheckTimer =



    setInterval(async () => {



      attempts += 1;







      const connected =



        await verifyWhatsAppConnection();







      if (connected) {



        return;



      }







      if (attempts >= 36) {

        stopConnectionChecker();



        whatsappReady = false;

        whatsappInitializing = false;



        setWhatsAppConnectionState(

          "RECOVERING"

        );



        console.error(

          "❌ WhatsApp did not reach CONNECTED state after 3 minutes."

        );



        scheduleWhatsAppReconnect(

          "connection timeout"

        );

      }



    }, 5000);



}







/* =========================================



   WHATSAPP EVENTS



========================================= */







whatsappClient.on("qr", async (qr) => {



  const generationVersion = ++qrGenerationVersion;



  const generatedAt = new Date();







  whatsappReady = false;
  whatsappPairingRequired = true;
  authenticatedAt = null;



  setWhatsAppConnectionState("UNPAIRED");







  console.log("");



  console.log("=========================================");



  console.log("📱 WhatsApp QR generated");



  console.log("Open WMS Settings → WhatsApp and scan the QR there.");



  console.log("=========================================");







  try {



    const qrcode = await import("qrcode");







    const dataUrl = await qrcode.default.toDataURL(qr, {



      width: 320,



      margin: 2,



      errorCorrectionLevel: "M",



    });







    // Ignore an older async conversion if a newer QR was already generated



    // or if the client became connected while this QR was being rendered.



    if (generationVersion !== qrGenerationVersion || whatsappReady) {



      return;



    }







    latestQrDataUrl = dataUrl;



    latestQrGeneratedAt = generatedAt;



  } catch (error) {



    console.error(



      "❌ Could not create WhatsApp QR image:",



      error?.message || error



    );



  }



});







whatsappClient.on(



  "authenticated",



  () => {



    authenticatedAt = new Date();
    whatsappPairingRequired = false;



    setWhatsAppConnectionState("AUTHENTICATED");



    clearWhatsAppQr();







    console.log(



      "✅ WhatsApp authenticated"



    );







    startConnectionChecker();



  }



);







whatsappClient.on(



  "ready",



  () => {



    markWhatsAppReady(



      "ready event"



    );



  }



);







whatsappClient.on(



  "change_state",



  (state) => {



    setWhatsAppConnectionState(state);







    console.log(



      "📡 WhatsApp state changed:",



      state



    );







    if (state === "CONNECTED") {



      markWhatsAppReady(



        "change_state CONNECTED"



      );



    }



  }



);







whatsappClient.on(

  "auth_failure",

  (message) => {

    whatsappReady = false;

    whatsappInitializing = false;
    whatsappPairingRequired = false;



    setWhatsAppConnectionState(

      "AUTH_FAILURE"

    );



    clearWhatsAppQr();

    stopConnectionChecker();



    console.error(

      "❌ WhatsApp authentication failed:",

      message

    );



    /*

      Do not delete LocalAuth automatically.

      First try to recover the existing session.

    */

    scheduleWhatsAppReconnect(

      "authentication failure"

    );

  }

);



whatsappClient.on(

  "disconnected",

  (reason) => {

    whatsappReady = false;

    whatsappInitializing = false;
    whatsappPairingRequired = false;



    setWhatsAppConnectionState(

      "DISCONNECTED"

    );



    clearWhatsAppQr();

    stopConnectionChecker();



    if (
      String(reason || "")
        .toUpperCase()
        .includes("LOGOUT")
    ) {
      authenticatedAt = null;
    }



    console.error(

      "❌ WhatsApp disconnected:",

      reason

    );



    /*

      Keep LocalAuth/session.

      Automatically recover same account.

    */

    scheduleWhatsAppReconnect(

      `disconnected: ${reason || "unknown"}`

    );

  }

);



whatsappClient.on(



  "loading_screen",



  (percent, message) => {



    console.log(



      `WhatsApp loading: ${percent}% ${message || ""}`



    );



  }



);







/* =========================================



   INITIALIZE WHATSAPP



========================================= */








async function probeWhatsAppWebReachability() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  timeout.unref?.();

  const startedAt = Date.now();

  console.log("🧪 WhatsApp network probe: starting");

  try {
    const response = await fetch("https://web.whatsapp.com/", {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });

    console.log(
      `🧪 WhatsApp network probe: HTTP ${response.status} in ${Date.now() - startedAt}ms`
    );

    try {
      await response.body?.cancel?.();
    } catch {
      // Nothing else is needed from the probe response.
    }

    return true;
  } catch (error) {
    const label =
      error?.name === "AbortError"
        ? "TIMEOUT"
        : String(error?.message || error || "unknown error");

    console.warn(
      `🧪 WhatsApp network probe failed after ${Date.now() - startedAt}ms: ${label}`
    );

    return false;
  } finally {
    clearTimeout(timeout);
  }
}


async function initializeWhatsApp() {
  if (
    whatsappShuttingDown
  ) {
    return false;
  }



  if (whatsappReady) {
    return true;
  }



  if (whatsappInitializing) {
    return false;
  }



  /*
    Set the in-process initialization guard BEFORE lock/profile
    cleanup because that cleanup can await for a few seconds.
    This prevents startup/reconnect timers in the same Node
    process from entering initialize() at the same time.
  */
  whatsappInitializing = true;

  /*
    Prevent two overlapping Hostinger Node processes
    from opening the same LocalAuth Chromium profile.
  */
  if (!tryAcquireWhatsAppProcessLock()) {
    whatsappInitializing = false;

    setWhatsAppConnectionState(
      "WAITING_FOR_OWNER"
    );

    return false;
  }

  /*
    A previous Chromium can outlive Node briefly or leave
    SingletonLock / DevToolsActivePort behind after a crash.
    Clean only verified stale runtime state before launching.
  */
  const profileReady =
    await cleanupStaleWhatsAppChromiumProfile();

  if (!profileReady) {
    whatsappInitializing = false;
    lastInitializeNeedsCooldown = true;

    setWhatsAppConnectionState(
      "WAITING_FOR_BROWSER_RELEASE"
    );

    /*
      We failed before WhatsApp/Chromium became usable.
      Do not keep the cross-process owner lease while this
      process is only waiting. Releasing it lets the newest
      Hostinger process safely attempt takeover. The next
      attempt must acquire the lock again before touching
      the shared LocalAuth profile.
    */
    releaseWhatsAppProcessLock();

    return false;
  }



  whatsappProcessLockBlocked = false;
  lastInitializeNeedsCooldown = false;



  setWhatsAppConnectionState(
    reconnectRunning
      ? "RECOVERING"
      : "STARTING"
  );



  try {
    console.log(
      `Starting WhatsApp Web... PID ${process.pid}`
    );

    await probeWhatsAppWebReachability();



    const initializeDiagnosticTimer = setInterval(() => {
      let browserState = "missing";
      let pageState = "missing";
      let pageUrl = "unknown";

      try {
        if (whatsappClient?.pupBrowser) {
          browserState = whatsappClient.pupBrowser.isConnected?.()
            ? "connected"
            : "disconnected";
        }
      } catch {
        browserState = "error";
      }

      try {
        if (whatsappClient?.pupPage) {
          pageState = whatsappClient.pupPage.isClosed?.()
            ? "closed"
            : "open";
          pageUrl = whatsappClient.pupPage.url?.() || "unknown";
        }
      } catch {
        pageState = "error";
      }

      console.log(
        `🧪 WhatsApp initialize waiting: browser=${browserState}, page=${pageState}, url=${pageUrl}`
      );
    }, 10_000);

    initializeDiagnosticTimer.unref?.();

    try {
      await whatsappClient.initialize();
    } finally {
      clearInterval(initializeDiagnosticTimer);
    }



    attachWhatsAppBrowserCrashWatcher();



    /*
      ready/authenticated events normally
      update status.

      Checker is also started as a fallback.
    */
    if (!whatsappReady && !whatsappPairingRequired) {
      startConnectionChecker();
    }



    return true;
  } catch (error) {
    const message =
      String(
        error?.message ||
        error ||
        ""
      );



    console.warn(
      "⚠️ WhatsApp initialize warning:",
      message
    );



    whatsappReady = false;



    /*
      These errors normally mean the previous Chromium
      process/profile has not finished shutting down yet.
      Do not hammer Hostinger with rapid browser launches.
    */
    lastInitializeNeedsCooldown =
      /browser is already running/i.test(message) ||
      /ECONNREFUSED\s+127\.0\.0\.1/i.test(message) ||
      /resource temporarily unavailable/i.test(message) ||
      /failed to launch the browser process/i.test(message);



    setWhatsAppConnectionState(
      "RECOVERING"
    );

    /*
      initialize() did not produce a usable Chromium client.
      Keeping the owner lock here can deadlock a rolling
      Hostinger deploy: the failed old Node process keeps
      heartbeating while the healthy replacement waits.
      Release only the small AZI owner lease. LocalAuth and
      the WhatsApp session directory remain untouched.
    */
    releaseWhatsAppProcessLock();

    return false;
  } finally {
    whatsappInitializing = false;
  }
}



const WHATSAPP_START_DELAY_MS = Math.max(0, Number(process.env.WHATSAPP_START_DELAY_MS || 1000));



console.log(`⏳ WhatsApp startup scheduled in ${WHATSAPP_START_DELAY_MS}ms`);



setTimeout(async () => {
  try {
    const initializedSuccessfully =
      await initializeWhatsApp();



    if (
      !initializedSuccessfully &&
      !whatsappReady &&
      !whatsappPairingRequired
    ) {
      const retryDelay = whatsappProcessLockBlocked
        ? WHATSAPP_OWNER_LOCK_RETRY_MS
        : lastInitializeNeedsCooldown
          ? WHATSAPP_BROWSER_CONFLICT_RETRY_MS
          : null;

      scheduleWhatsAppReconnect(
        whatsappProcessLockBlocked
          ? "waiting for previous Hostinger WhatsApp process to stop"
          : "startup initialize failed",
        retryDelay
      );
    }
  } catch (error) {
    whatsappReady = false;
    whatsappInitializing = false;



    setWhatsAppConnectionState(
      "ERROR"
    );



    console.error(
      "❌ Delayed WhatsApp initialization failed:",
      error?.message || error
    );



    scheduleWhatsAppReconnect(
      "startup exception",
      lastInitializeNeedsCooldown
        ? WHATSAPP_BROWSER_CONFLICT_RETRY_MS
        : null
    );
  }
}, WHATSAPP_START_DELAY_MS);







/* =========================================



   CONFIGURATION



========================================= */









/* =========================================

   AZI WHATSAPP HEALTH WATCHDOG V2

========================================= */



function startWhatsAppHealthWatchdog() {

  if (healthTimer) {

    return;

  }



  console.log(

    "🩺 WhatsApp health watchdog started."

  );



  healthTimer =

    setInterval(

      async () => {

        /*

          Do not interfere while WhatsApp

          is already starting/recovering.

        */

        if (
          whatsappShuttingDown ||
          whatsappInitializing ||
          reconnectRunning ||
          reconnectTimer
        ) {
          return;
        }



        /*
          This process is waiting for another Hostinger
          process to release the persistent WhatsApp profile.
          Never call getState() on an uninitialized client.
        */
        if (
          whatsappProcessLockBlocked &&
          !whatsappProcessLockOwned
        ) {
          healthFails = 0;

          if (!reconnectTimer) {
            scheduleWhatsAppReconnect(
              "waiting for WhatsApp process owner",
              WHATSAPP_OWNER_LOCK_RETRY_MS
            );
          }

          return;
        }



        /*
          A QR means the saved session really needs
          pairing. Do not keep restarting Chromium
          while the user is expected to scan it.
        */
        if (whatsappPairingRequired) {
          healthFails = 0;

          return;
        }



        const connected =
          await verifyWhatsAppConnection();



        if (connected) {

          healthFails = 0;

          reconnectAttempt = 0;



          return;

        }



        healthFails += 1;



        console.warn(

          `⚠️ WhatsApp health check failed (${healthFails}/${HEALTH_FAIL_LIMIT})`

        );



        /*

          One temporary state failure

          should not restart Chromium.



          Recover only after 3 failures.

        */

        if (healthFails < HEALTH_FAIL_LIMIT) {

          return;

        }



        healthFails = 0;

        whatsappReady = false;



        setWhatsAppConnectionState(

          "RECOVERING"

        );



        scheduleWhatsAppReconnect(

          `${HEALTH_FAIL_LIMIT} consecutive health checks failed`

        );

      },

      HEALTH_CHECK_MS

    );



  healthTimer.unref?.();

}



startWhatsAppHealthWatchdog();



export function whatsappConfigured() {



  return whatsappReady;



}







export async function getWhatsAppWebStatus() {



  let liveState = whatsappConnectionState;







  try {



    const state = await whatsappClient.getState();







    if (state) {



      liveState = state;



      setWhatsAppConnectionState(state);



    }







    if (state === "CONNECTED") {



      markWhatsAppReady("settings status check");



    }



  } catch {



    // During startup or QR pairing getState() can temporarily fail.



    // In that case we safely return the last event-driven state.



  }







  const connected =



    whatsappReady ||



    liveState === "CONNECTED";







  if (connected) {



    clearWhatsAppQr();



  }







  if (



    latestQrGeneratedAt &&



    Date.now() - latestQrGeneratedAt.getTime() > WHATSAPP_QR_TTL_MS



  ) {



    clearWhatsAppQr();



  }







  return {



    connected,



    state: connected ? "CONNECTED" : whatsappConnectionState,



    qrDataUrl: connected ? null : latestQrDataUrl,



    qrGeneratedAt: latestQrGeneratedAt



      ? latestQrGeneratedAt.toISOString()



      : null,



    authenticatedAt: authenticatedAt



      ? authenticatedAt.toISOString()



      : null,



  };



}







/* =========================================



   PHONE NORMALIZATION



========================================= */







export function normalizeWhatsAppPhone(



  phone



) {



  const digits =



    String(phone || "")



      .replace(/\D/g, "");







  if (!digits) {



    return "";



  }







  // Already Afghanistan international format



  if (digits.startsWith("93")) {



    return digits;



  }







  // Example:



  // 0789635780 -> 93789635780



  if (digits.startsWith("0")) {



    return `93${digits.slice(1)}`;



  }







  return digits;



}







function whatsappChatId(phone) {



  const normalized =



    normalizeWhatsAppPhone(phone);







  if (!normalized) {



    throw new Error(



      "WhatsApp phone number is missing."



    );



  }







  return `${normalized}@c.us`;



}







/* =========================================



   DETACHED FRAME RECOVERY



   WhatsApp Web can navigate/reload its main frame while a send is

   starting. In that race whatsapp-web.js can throw:

   "Attempted to use detached Frame ...".



   Do NOT create a second Client/Chromium here. We keep the existing

   LocalAuth session, wait for/recover the active WhatsApp page, verify

   CONNECTED again, and retry the send exactly once.



========================================= */



function sleep(ms) {



  return new Promise((resolve) => setTimeout(resolve, ms));



}







function isWhatsAppFrameNavigationError(error) {



  const message = String(error?.message || error || "").toLowerCase();







  return (



    message.includes("detached frame") ||



    message.includes("execution context was destroyed") ||



    message.includes("cannot find context with specified id") ||



    message.includes("inspected target navigated or closed") ||



    message.includes("navigating frame was detached")



  );



}







async function findUsableWhatsAppPage() {



  let page = whatsappClient.pupPage || null;







  if (page && !page.isClosed()) {



    try {



      page.mainFrame();



      return page;



    } catch {



      // Fall through and find the live WhatsApp tab from the browser.



    }



  }







  const browser = whatsappClient.pupBrowser;







  if (!browser || !browser.connected) {



    return null;



  }







  const pages = await browser.pages();







  page =



    pages.find((candidate) => {



      if (!candidate || candidate.isClosed()) return false;







      try {



        return candidate.url().includes("web.whatsapp.com");



      } catch {



        return false;



      }



    }) ||



    pages.find((candidate) => candidate && !candidate.isClosed()) ||



    null;







  if (page) {



    whatsappClient.pupPage = page;



  }







  return page;



}







async function waitForWhatsAppPageReady(page, timeoutMs = 20_000) {



  const startedAt = Date.now();



  let lastError = null;







  while (Date.now() - startedAt < timeoutMs) {



    if (!page || page.isClosed()) {



      return false;



    }







    try {



      const ready = await page.evaluate(() => {



        return (



          document.readyState !== "loading" &&



          Boolean(window.Store) &&



          Boolean(window.WWebJS)



        );



      });







      if (ready) {



        return true;



      }



    } catch (error) {



      lastError = error;



    }







    await sleep(750);



  }







  if (lastError) {



    console.warn(



      "⚠️ WhatsApp page was not ready after frame recovery:",



      lastError?.message || lastError



    );



  }







  return false;



}







async function recoverWhatsAppDetachedFrame() {



  if (detachedFrameRecoveryPromise) {



    console.log(



      "⏳ WhatsApp detached-frame recovery is already running; waiting for it..."



    );







    return detachedFrameRecoveryPromise;



  }







  detachedFrameRecoveryPromise = (async () => {





      whatsappReady = false;



      setWhatsAppConnectionState("RECOVERING");







      console.warn(



        "♻️ WhatsApp frame changed during send. Recovering the existing session..."



      );







      stopConnectionChecker();







      let page = await findUsableWhatsAppPage();







      if (!page) {



        setWhatsAppConnectionState("ERROR");



        throw new Error(



          "WhatsApp browser page is unavailable after detached-frame error."



        );



      }







      // A navigation race often settles by itself. Give the new main frame a



      // short chance before forcing a reload.



      await sleep(1200);







      let pageReady = await waitForWhatsAppPageReady(page, 8_000);







      if (!pageReady) {



        console.warn(



          "🔄 WhatsApp page is still stale. Reloading the existing WhatsApp tab once..."



        );







        try {



          await page.reload({



            waitUntil: "domcontentloaded",



            timeout: 60_000,



          });



        } catch (error) {



          if (!isWhatsAppFrameNavigationError(error)) {



            throw error;



          }



        }







        await sleep(1500);







        // whatsapp-web.js normally reinjects on main-frame navigation. If the



        // helper objects are still missing, request one explicit injection on



        // the same page. The postinstall page-binding patch makes duplicate



        // exposed bindings safe during this recovery path.



        pageReady = await waitForWhatsAppPageReady(page, 5_000);







        if (!pageReady && typeof whatsappClient.inject === "function") {



          try {



            await whatsappClient.inject();



          } catch (error) {



            const message = String(error?.message || error || "");







            if (



              !isWhatsAppFrameNavigationError(error) &&



              !/already exists/i.test(message)



            ) {



              throw error;



            }



          }







          page = await findUsableWhatsAppPage();



          pageReady = await waitForWhatsAppPageReady(page, 10_000);



        }



      }







      if (!pageReady) {



        startConnectionChecker();



        throw new Error(



          "WhatsApp page did not become ready after detached-frame recovery."



        );



      }







      // getState can lag slightly behind the page becoming usable. Poll briefly



      // without creating a new WhatsApp client/browser.



      for (let attempt = 1; attempt <= 12; attempt += 1) {



        const connected = await verifyWhatsAppConnection();







        if (connected) {



          console.log(



            "✅ WhatsApp detached-frame recovery completed."



          );







          return true;



        }







        await sleep(1000);



      }







      startConnectionChecker();







      throw new Error(



        "WhatsApp did not reconnect after detached-frame recovery."



      );



  })();







  try {



    return await detachedFrameRecoveryPromise;



  } finally {



    detachedFrameRecoveryPromise = null;



  }



}





async function sendWithDetachedFrameRetry({



  label,



  send,



}) {



  try {



    return await send();



  } catch (error) {



    if (!isWhatsAppFrameNavigationError(error)) {



      throw error;



    }







    console.warn(



      `⚠️ ${label} hit a detached WhatsApp frame. Recovering and retrying once...`



    );







    await recoverWhatsAppDetachedFrame();







    return await send();



  }



}







/* =========================================



   SEND TEXT MESSAGE



========================================= */







async function sendWhatsAppText({



  to,



  text,



}) {



  if (!whatsappReady) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappReady) {



    throw new Error(



      "WhatsApp Web is not connected yet."



    );



  }







  const phone =



    normalizeWhatsAppPhone(to);







  if (!phone) {



    throw new Error(



      "WhatsApp phone number is missing or invalid."



    );



  }







  const chatId =



    whatsappChatId(phone);







  const messageText =



    String(text || "").trim();







  if (!messageText) {



    throw new Error(



      "WhatsApp message text is empty."



    );



  }







  console.log(



    `📤 Sending WhatsApp TEXT to ${phone}...`



  );







  const message =



    await whatsappClient.sendMessage(



      chatId,



      messageText



    );







  console.log(



    `✅ WhatsApp TEXT sent successfully to ${phone}`



  );







  return message;



}







/* =========================================



   SEND PNG IMAGE



========================================= */







async function sendWhatsAppPng({



  to,



  buffer,



  filename = "report.png",



  caption = "",



}) {



  if (!whatsappReady) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappReady) {



    throw new Error(



      "WhatsApp Web is not connected yet."



    );



  }







  const phone =



    normalizeWhatsAppPhone(to);







  if (!phone) {



    throw new Error(



      "WhatsApp phone number is missing or invalid."



    );



  }







  if (



    !Buffer.isBuffer(buffer) ||



    buffer.length === 0



  ) {



    throw new Error(



      "PNG buffer is empty."



    );



  }







  const chatId =



    whatsappChatId(phone);







  console.log(



    `📤 Sending WhatsApp PNG to ${phone}...`



  );







  const message =



    await sendWithDetachedFrameRetry({



      label: `WhatsApp PNG send to ${phone}`,



      send: () => {



        // Create fresh MessageMedia for each attempt because whatsapp-web.js



        // can mutate prepared media data during send preparation.



        const attemptMedia =



          new MessageMedia(



            "image/png",



            buffer.toString("base64"),



            filename



          );







        return whatsappClient.sendMessage(



          chatId,



          attemptMedia,



          {



            caption:



              String(caption || ""),



          }



        );



      },



    });







  console.log(



    `✅ WhatsApp PNG sent successfully to ${phone}`



  );







  return message;



}











/* =========================================



   SEND PDF DOCUMENT



========================================= */







async function sendWhatsAppPdf({



  to,



  buffer,



  filename = "account-report.pdf",



  caption = "",



}) {



  if (!whatsappReady) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappReady) {



    throw new Error("WhatsApp Web is not connected yet.");



  }







  const phone = normalizeWhatsAppPhone(to);



  if (!phone) {



    throw new Error("WhatsApp phone number is missing or invalid.");



  }







  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {



    throw new Error("PDF buffer is empty.");



  }







  const chatId = whatsappChatId(phone);



  const media = new MessageMedia(



    "application/pdf",



    buffer.toString("base64"),



    filename



  );







  console.log(`📤 Sending WhatsApp PDF to ${phone}...`);







  const message = await whatsappClient.sendMessage(



    chatId,



    media,



    { caption: String(caption || "") }



  );







  console.log(`✅ WhatsApp PDF sent successfully to ${phone}`);



  return message;



}











/* =========================================



   RECEIPT / SHOP SETTINGS



========================================= */







async function getReceiptShopSettings() {



  const defaults = {



    company_name: "نیازی پلورنځی",



    shop_name: "نیازی پلورنځی",



    shop_address: "",



    logo_url: "",



    receipt_title: "د وصولۍ رسید",



    weekly_report_title: "د حساب راپور",



  };







  try {



    /*



      IMPORTANT:



      Company logo/name/address must always come from company_settings,



      because this is the same Settings page used by the WMS.



      WhatsApp automation settings are used only for WhatsApp-specific



      titles/branding fields when they exist.



    */



    const [



      companyResult,



      whatsappResult,



    ] = await Promise.all([



      supabaseAdmin



        .from("company_settings")



        .select("*")



        .eq("id", 1)



        .maybeSingle(),







      supabaseAdmin



        .from("whatsapp_automation_settings")



        .select("*")



        .eq("id", 1)



        .maybeSingle(),



    ]);







    if (companyResult.error) {



      console.warn(



        "⚠️ Could not load company settings:",



        companyResult.error.message



      );



    }







    if (whatsappResult.error) {



      console.warn(



        "⚠️ Could not load WhatsApp branding settings:",



        whatsappResult.error.message



      );



    }







    const company = companyResult.data || {};



    const whatsapp = whatsappResult.data || {};







    return {



      ...defaults,







      // MAIN WMS SETTINGS



      company_name:



        company.company_name ||



        defaults.company_name,







      shop_name:



        company.company_name ||



        defaults.shop_name,







      shop_address:



        company.address ||



        "",







      logo_url:



        company.logo_url ||



        "",







      // WHATSAPP-SPECIFIC TITLES



      receipt_title:



        whatsapp.receipt_title ||



        defaults.receipt_title,







      weekly_report_title:



        whatsapp.weekly_report_title ||



        whatsapp.report_title ||



        defaults.weekly_report_title,







      // Keep useful company fields available to report templates.



      address: company.address || "",



      phone: company.phone || "",



      email: company.email || "",



      currency: company.currency || "AFN",



      date_format: company.date_format || "",



    };



  } catch (error) {



    console.warn(



      "⚠️ Receipt/settings fallback:",



      error?.message || error



    );







    return defaults;



  }



}







/* =========================================



   CUSTOMER TOTALS



========================================= */







async function getCustomerTotals(



  customerId



) {



  const [



    customerResult,



    paymentResult,



  ] = await Promise.all([



    supabaseAdmin



      .from("customers")



      .select("*")



      .eq(



        "id",



        customerId



      )



      .single(),







    supabaseAdmin



      .from("payments")



      .select("amount")



      .eq(



        "customer_id",



        customerId



      ),



  ]);







  const customer =



    customerResult.data;







  const payments =



    paymentResult.data || [];







  if (



    customerResult.error ||



    !customer



  ) {



    throw new Error(



      customerResult.error?.message ||



      "Customer not found."



    );



  }







  if (paymentResult.error) {



    throw new Error(



      paymentResult.error.message



    );



  }







  const totalPaid =



    payments.reduce(



      (sum, payment) =>



        sum +



        Number(



          payment.amount || 0



        ),



      0



    );







  const remainingBalance =



    Number(



      customer.current_balance || 0



    );







  const totalDebt =



    remainingBalance +



    totalPaid;







  return {



    customer,



    totalPaid,



    remainingBalance,



    totalDebt,



  };



}







/* =========================================



   PAYMENT RECEIPT



   AUTOMATIC PNG



========================================= */







export async function sendPaymentReceipt(



  job



) {



  if (!whatsappConfigured()) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappConfigured()) {



    throw new Error(



      "WhatsApp Web is not connected."



    );



  }







  /* -------------------------



     CUSTOMER



  ------------------------- */







  const {



    data: customer,



    error: customerError,



  } =



    await supabaseAdmin



      .from("customers")



      .select("*")



      .eq(



        "id",



        job.customer_id



      )



      .single();







  if (



    customerError ||



    !customer



  ) {



    throw new Error(



      customerError?.message ||



      "Customer not found."



    );



  }







  /* -------------------------



     PAYMENT



  ------------------------- */







  const paymentId =



    job.payment_id ||



    job.payload?.payment_id;







  let payment = null;







  if (paymentId) {



    const {



      data,



      error,



    } =



      await supabaseAdmin



        .from("payments")



        .select("*")



        .eq(



          "id",



          paymentId



        )



        .maybeSingle();







    if (error) {



      throw new Error(



        error.message



      );



    }







    payment = data;



  }







  payment =



    payment ||



    job.payload?.payment ||



    {};







  /* -------------------------



     AMOUNT



  ------------------------- */







  const amount =



    Number(



      payment.amount ||



      job.payload?.amount ||



      0



    );







  if (amount <= 0) {



    throw new Error(



      "Receipt payment amount is missing."



    );



  }







  /* -------------------------



     PHONE



  ------------------------- */







  const phone =



    normalizeWhatsAppPhone(



      customer.phone ||



      job.phone



    );







  if (!phone) {



    return {



      skipped: true,



      reason: "missing_phone",



    };



  }







  /* -------------------------



     BALANCE



  ------------------------- */







  const remainingBalance =



    Number(



      job.payload



        ?.remaining_balance ??



      customer.current_balance ??



      0



    );







  /* -------------------------



     CURRENCY



  ------------------------- */







  const currency =



    customer.currency ||



    job.payload?.currency ||



    "AFN";







  /* -------------------------



     CREATE PNG



  ------------------------- */







  const shopSettings =



    await getReceiptShopSettings();







  console.log(



    `🧾 Creating payment receipt PNG for ${customer.name || "customer"}...`



  );







  const pngBuffer =



    await createPaymentReceiptPng({



      company: shopSettings,







      customer,







      payment,







      remainingBalance,







      currency,



    });







  console.log(



    `✅ Payment receipt PNG created for ${customer.name || "customer"}`



  );







  /* -------------------------



     SEND AUTOMATICALLY



     NO OK BUTTON



  ------------------------- */







  const result =



    await sendWhatsAppPng({



      to: phone,







      buffer: pngBuffer,







      filename:



        `payment-receipt-${payment.id || Date.now()}.png`,







      caption:



        `محترم *${customer.name || "مشتري"} صاحب* 🌿\n` +



        `ستاسو د وصولۍ رسید د فضل پلورنځي لخوا در واستول شو.\n` +



        `له باور او همکارۍ مو مننه.\n` +



        `*FZL1650*`,



    });







  return {



    skipped: false,







    messageId:



      result?.id?._serialized ||



      result?.id?.id ||



      null,







    mediaPath: null,



  };



}







/* =========================================



   WEEKLY DEBT REPORT



   AUTOMATIC PNG



========================================= */







export async function sendWeeklyDebtReport(



  job



) {



  if (!whatsappConfigured()) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappConfigured()) {



    throw new Error(



      "WhatsApp Web is not connected."



    );



  }







  const {



    customer,



    totalPaid,



    totalDebt,



    remainingBalance,



  } =



    await getCustomerTotals(



      job.customer_id



    );







  /*



    Weekly report:



    Only customers who still owe money.



  */







  if (remainingBalance <= 0) {



    console.log(



      `[WhatsApp] Weekly report skipped for ${customer.name}: balance is 0`



    );







    return {



      skipped: true,



      reason: "balance_zero",



    };



  }







  const phone =



    normalizeWhatsAppPhone(



      customer.phone ||



      job.phone



    );







  if (!phone) {



    return {



      skipped: true,



      reason: "missing_phone",



    };



  }







  const currency =



    customer.currency ||



    "AFN";







  const shopSettings =



    await getReceiptShopSettings();







  console.log(



    `📊 Creating weekly debt PNG for ${customer.name || "customer"}...`



  );







  const pngBuffer =



    await createWeeklyDebtReportPng({



      company: shopSettings,







      customer,







      totalDebt,







      totalPaid,







      remainingBalance,







      currency,







      generatedAt:



        new Date(),



    });







  console.log(



    `✅ Weekly debt PNG created for ${customer.name || "customer"}`



  );







  const result =



    await sendWhatsAppPng({



      to: phone,







      buffer: pngBuffer,







      filename:



        `weekly-account-${customer.id}-${Date.now()}.png`,







      caption:



        `ښاغلی *${customer.name || "مشتري"} صاحب* 🌟\n` +



        `ستاسو اوونیز راپور د فضل پلورنځي لخوا در واستول شو 📊\n` +



        `مننه چې مونږ سره یاست 🤝\n` +



        `*FZL1650*`,



    });







  return {



    skipped: false,







    messageId:



      result?.id?._serialized ||



      result?.id?.id ||



      null,







    mediaPath: null,



  };



}







/* =========================================



   FULL ACCOUNT REPORT



   EVERY 3 WEEKS







   IMPORTANT:



   This remains TEXT temporarily.







   We will connect the complete PDF



   after verifying sales_invoices +



   payments + balance records logic.



========================================= */











async function getFullAccountTransactions(customerId) {



  const [salesResult, paymentsResult, balanceResult] = await Promise.all([



    supabaseAdmin



      .from("sales_invoices")



      .select("*")



      .eq("customer_id", customerId)



      .order("created_at", { ascending: true }),







    supabaseAdmin



      .from("payments")



      .select("*")



      .eq("customer_id", customerId)



      .order("created_at", { ascending: true }),







    supabaseAdmin



      .from("debtor_balance_records")



      .select("*")



      .eq("customer_id", customerId)



      .order("created_at", { ascending: true }),



  ]);







  if (salesResult.error) throw new Error(salesResult.error.message);



  if (paymentsResult.error) throw new Error(paymentsResult.error.message);







  // Older databases may not yet have debtor_balance_records.



  if (balanceResult.error) {



    console.warn(



      "⚠️ debtor_balance_records could not be loaded:",



      balanceResult.error.message



    );



  }







  const raw = [];







  for (const invoice of salesResult.data || []) {



    raw.push({



            ...invoice,



date:



        invoice.invoice_date ||



        invoice.date ||



        invoice.created_at,



      sortDate: new Date(



        invoice.invoice_date ||



        invoice.date ||



        invoice.created_at ||



        0



      ).getTime(),



      description:



        `د خرڅلاو بل${invoice.invoice_number ? ` #${invoice.invoice_number}` : ""}`,



      debit: Number(



        invoice.total_amount ??



        invoice.grand_total ??



        invoice.total ??



        invoice.amount ??



        0



      ),



      credit: 0,



    });



  }







  for (const payment of paymentsResult.data || []) {



    raw.push({



            ...payment,



date:



        payment.payment_date ||



        payment.date ||



        payment.created_at,



      sortDate: new Date(



        payment.payment_date ||



        payment.date ||



        payment.created_at ||



        0



      ).getTime(),



      description:



        payment.note ||



        payment.description ||



        "وصولي",



      debit: 0,



      credit: Number(payment.amount || 0),



    });



  }







  for (const record of balanceResult.data || []) {



    const amount = Number(



      record.amount ??



      record.balance_amount ??



      record.value ??



      0



    );







    raw.push({



            ...record,



date:



        record.record_date ||



        record.date ||



        record.created_at,



      sortDate: new Date(



        record.record_date ||



        record.date ||



        record.created_at ||



        0



      ).getTime(),



      description:



        record.note ||



        record.description ||



        "د حساب ثبت",



      debit: amount > 0 ? amount : 0,



      credit: amount < 0 ? Math.abs(amount) : 0,



    });



  }







  raw.sort((a, b) => a.sortDate - b.sortDate);







  let runningBalance = 0;







  return raw.map((item) => {



    runningBalance += Number(item.debit || 0);



    runningBalance -= Number(item.credit || 0);







    return {



      ...item,



      date: item.date



        ? String(item.date).slice(0, 10).replace(/-/g, "/")



        : "—",



      description: item.description,



      debit: item.debit,



      credit: item.credit,



      balance: runningBalance,



    };



  });



}











export async function sendFullAccountReport(



  job



) {



  if (!whatsappConfigured()) {



    await verifyWhatsAppConnection();



  }







  if (!whatsappConfigured()) {



    throw new Error("WhatsApp Web is not connected.");



  }







  const {



    customer,



    totalPaid,



    totalDebt,



    remainingBalance,



  } = await getCustomerTotals(job.customer_id);







  const phone = normalizeWhatsAppPhone(



    customer.phone || job.phone



  );







  if (!phone) {



    return {



      skipped: true,



      reason: "missing_phone",



    };



  }







  const currency = customer.currency || "AFN";



  const shopSettings = await getReceiptShopSettings();



  const transactions = await getFullAccountTransactions(



    job.customer_id



  );







  console.log(



    `📄 Creating 3-week full account PDF for ${customer.name || "customer"}...`



  );







  const pdfBuffer = await createFullAccountReportPdf({



    company: shopSettings,



    customer,



    transactions,



    totalDebt,



    totalPaid,



    remainingBalance,



    currency,



    generatedAt: new Date(),



  });







  const result = await sendWhatsAppPdf({



    to: phone,



    buffer: pdfBuffer,



    filename:



      `full-account-${customer.id}-${Date.now()}.pdf`,



    caption:



      `محترم *${customer.name || "مشتري"} صاحب* 📋\n` +



      `ستاسو بشپړ حساب راپور د فضل پلورنځي لخوا در واستول شو ✅\n` +



      `ستاسو له باور او همکارۍ څخه مننه 🤝\n` +



      `*FZL1650*`,



  });







  return {



    skipped: false,



    messageId:



      result?.id?._serialized ||



      result?.id?.id ||



      null,



    mediaPath: null,



    format: "pdf",



  };



}











/* =========================================



   GENERIC ACCOUNT REPORT



========================================= */







export async function sendAccountReport(



  job



) {



  if (



    job?.job_type ===



    "full_debt_report"



  ) {



    return sendFullAccountReport(



      job



    );



  }







  return sendWeeklyDebtReport(



    job



  );



}







/* =========================================



   SIMPLE TEST MESSAGE



========================================= */







export async function sendTestWhatsAppMessage(



  phone,



  text = "فضل پلورنځی WhatsApp Test ✅"



) {



  return sendWhatsAppText({



    to: phone,



    text,



  });



}







/* =========================================



   EXPORT CLIENT



========================================= */







export {



  whatsappClient,



  verifyWhatsAppConnection,



};







/* =========================================



   SETTINGS TEST MESSAGE COMPATIBILITY



========================================= */



export async function sendWhatsAppTestMessage({ to, text }) {



  const phone = normalizeWhatsAppPhone(to);







  if (!phone) {



    throw new Error(



      "د Test Message لپاره صحیح WhatsApp نمبر ولیکئ."



    );



  }







  const body =



    String(text || "").trim() ||



    "السلام علیکم، دا د فضل پلورنځي د WhatsApp اتومات سیستم ازمایښتي پیغام دی.";







  await sendWhatsAppText({



    to: phone,



    text: body,



  });







  return {



    success: true,



    phone,



    message: "WhatsApp Test Message په بریالیتوب ولېږل شو.",



    provider: "whatsapp-web",



  };



}
