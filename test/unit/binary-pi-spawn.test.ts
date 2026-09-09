import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBunPiExecutable } from "../../src/runs/shared/pi-spawn.ts";

describe("compiled background host detection", () => {
	const host = {
		execPath: "/opt/standalone/pi-native",
		argv1: "/$bunfs/root/pi-native",
		bunVersion: "1.3.14",
		env: {},
	};

	it("uses the actual image even when renamed", () => {
		assert.equal(resolveBunPiExecutable(host), host.execPath);
	});

	it("honors a nonempty override, otherwise retaining the actual image", () => {
		assert.equal(resolveBunPiExecutable({ ...host, env: { PI_SUBAGENT_PI_BINARY: " /custom/pi " } }), "/custom/pi");
		assert.equal(resolveBunPiExecutable({ ...host, env: { PI_SUBAGENT_PI_BINARY: " " } }), host.execPath);
	});

	it("does not treat an ordinary Bun script or Node as a compiled host", () => {
		assert.equal(resolveBunPiExecutable({ ...host, argv1: "/work/script.ts" }), undefined);
		assert.equal(resolveBunPiExecutable({ ...host, bunVersion: "" }), undefined);
	});
});
