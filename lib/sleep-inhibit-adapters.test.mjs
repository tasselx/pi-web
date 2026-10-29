import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HOLDER_READY_LINE, holderEnvironment, planSleepInhibitor } = await jiti.import("./sleep-inhibit-adapters.ts");

/** 用假环境判断「这台机器能不能」，这样别的系统的分支也能在这里跑。 */
function environment({ platform, env = {}, commands = [], files = [] }) {
  return {
    platform,
    env,
    hasCommand: (name) => commands.includes(name),
    fileExists: (path) => files.includes(path),
  };
}

function flag(args, name) {
  return args.find((arg) => arg === name || arg.startsWith(`${name}=`));
}

test("macOS: caffeinate -i only, so the display may still turn off and manual sleep still works", () => {
  const plan = planSleepInhibitor(environment({ platform: "darwin", files: ["/usr/bin/caffeinate"] }));
  assert.equal(plan.supported, true);
  assert.equal(plan.holders.length, 1);
  const [holder] = plan.holders;
  assert.equal(holder.command, "/usr/bin/caffeinate");
  assert.equal(holder.args[0], "-i");
  // -d keeps the display on, -s holds on AC power only, -u declares user activity, -m the disk.
  assert.deepEqual(holder.args.filter((arg) => /^-[a-z]+$/.test(arg) && arg !== "-i" && arg !== "-c"), []);
  // The holder prints the ready line, then blocks on stdin until it is closed.
  assert.match(holder.args.join(" "), new RegExp(`echo ${HOLDER_READY_LINE}; exec cat`));
});

test("macOS without caffeinate is unavailable, with the reason", () => {
  const plan = planSleepInhibitor(environment({ platform: "darwin" }));
  assert.equal(plan.supported, false);
  assert.match(plan.reason, /caffeinate/);
});

test("Linux on GNOME tries gnome-session-inhibit (suspend only) before logind", () => {
  const plan = planSleepInhibitor(environment({
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    commands: ["gnome-session-inhibit", "systemd-inhibit"],
  }));
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.holders.map((holder) => holder.command), ["gnome-session-inhibit", "systemd-inhibit"]);
  const [gnome, logind] = plan.holders;
  assert.equal(gnome.args[gnome.args.indexOf("--inhibit") + 1], "suspend"); // not idle: the screen still dims
  assert.equal(flag(logind.args, "--what"), "--what=idle"); // not sleep: manual suspend still works
  assert.equal(flag(logind.args, "--mode"), "--mode=block");
});

test("Linux off GNOME, and without systemd, still finds a logind inhibitor", () => {
  const kde = planSleepInhibitor(environment({
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "KDE" },
    commands: ["gnome-session-inhibit", "systemd-inhibit"],
  }));
  assert.deepEqual(kde.holders.map((holder) => holder.command), ["systemd-inhibit"]);

  const elogind = planSleepInhibitor(environment({ platform: "linux", commands: ["elogind-inhibit"] }));
  assert.deepEqual(elogind.holders.map((holder) => holder.command), ["elogind-inhibit"]);

  // GNOME without its session tool falls back to logind rather than giving up.
  const bare = planSleepInhibitor(environment({
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "GNOME" },
    commands: ["systemd-inhibit"],
  }));
  assert.deepEqual(bare.holders.map((holder) => holder.command), ["systemd-inhibit"]);
});

test("Linux without any inhibitor does not assume systemd: unavailable, with how to fix it", () => {
  const plan = planSleepInhibitor(environment({ platform: "linux", env: { XDG_CURRENT_DESKTOP: "GNOME" } }));
  assert.equal(plan.supported, false);
  assert.match(plan.reason, /systemd-inhibit/);
  assert.match(plan.reason, /elogind-inhibit/);
});

test("Windows: a long-lived PowerShell holds ES_CONTINUOUS | ES_SYSTEM_REQUIRED on its blocked thread", () => {
  const bundled = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const bundledPlan = planSleepInhibitor(environment({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, files: [bundled] }));
  // Without the bundled copy (a moved system root) it falls back to PowerShell on PATH.
  const pathPlan = planSleepInhibitor(environment({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, commands: ["powershell.exe"] }));
  assert.equal(bundledPlan.holders[0].command, bundled);
  assert.equal(pathPlan.holders[0].command, "powershell.exe");
  for (const plan of [bundledPlan, pathPlan]) {
    assert.equal(plan.supported, true);
    const [holder] = plan.holders;
    assert.deepEqual(holder.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    assert.equal(holder.args[4], "-EncodedCommand");
    const script = Buffer.from(holder.args[5], "base64").toString("utf16le");
    const ES_CONTINUOUS = 0x80000000;
    const ES_SYSTEM_REQUIRED = 0x00000001;
    assert.match(script, new RegExp(`SetThreadExecutionState\\(${ES_CONTINUOUS + ES_SYSTEM_REQUIRED}\\)`));
    assert.doesNotMatch(script, /DISPLAY_REQUIRED|2147483651|2147483650/); // the display may still turn off
    // The thread that set the state stays alive: ready is reported, then it blocks reading stdin.
    assert.ok(script.indexOf("SetThreadExecutionState") < script.indexOf(HOLDER_READY_LINE));
    assert.ok(script.indexOf(HOLDER_READY_LINE) < script.indexOf("ReadToEnd"));
  }
});

test("Windows without PowerShell is unavailable", () => {
  const plan = planSleepInhibitor(environment({ platform: "win32", env: { SystemRoot: "C:\\Windows" } }));
  assert.equal(plan.supported, false);
  assert.match(plan.reason, /PowerShell/);
});

test("any other platform is unavailable and says which", () => {
  const plan = planSleepInhibitor(environment({ platform: "freebsd" }));
  assert.equal(plan.supported, false);
  assert.match(plan.reason, /freebsd/);
});

test("the holder's environment keeps the session bus variables but never Pi Web's password", () => {
  const env = holderEnvironment({
    PATH: "/usr/bin",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    PI_WEB_PASSWORD: "secret",
    pi_web_password: "secret",
  });
  assert.deepEqual(env, { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
});
