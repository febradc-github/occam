import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfigDir, resolveStateDir } from "./dirs.ts";

const lookup = (vars: Record<string, string>) => (name: string) => vars[name];

test("OCCAM_STATE_DIR wins over XDG_STATE_HOME and HOME", () => {
  const dir = resolveStateDir(lookup({ OCCAM_STATE_DIR: "/srv/occam/", XDG_STATE_HOME: "/x", HOME: "/home/u" }));
  assert.equal(dir, "/srv/occam");
});

test("XDG_STATE_HOME is used before HOME", () => {
  assert.equal(resolveStateDir(lookup({ XDG_STATE_HOME: "/x/state", HOME: "/home/u" })), "/x/state/occam");
});

test("empty or relative values fall through to the next candidate", () => {
  const dir = resolveStateDir(lookup({ OCCAM_STATE_DIR: "", XDG_STATE_HOME: "relative/state", HOME: "/home/u" }));
  assert.equal(dir, "/home/u/.local/state/occam");
});

test("returns null when no candidate is usable", () => {
  assert.equal(resolveStateDir(lookup({ HOME: "relative" })), null);
});

test("config dir follows OCCAM_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(resolveConfigDir(lookup({ OCCAM_CONFIG_DIR: "/c", XDG_CONFIG_HOME: "/x", HOME: "/home/u" })), "/c");
  assert.equal(resolveConfigDir(lookup({ XDG_CONFIG_HOME: "/x", HOME: "/home/u" })), "/x/occam");
  assert.equal(resolveConfigDir(lookup({ HOME: "/home/u" })), "/home/u/.config/occam");
});
