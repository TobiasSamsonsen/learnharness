import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_KEY_STATE, nextKeyState, type KeyedMessage } from "../components/stable-keys.ts";

const u = (id: string): KeyedMessage => ({ id, role: "user" });
const a = (id: string): KeyedMessage => ({ id, role: "assistant" });

describe("nextKeyState", () => {
	it("starts with the ids as keys", () => {
		const s = nextKeyState(EMPTY_KEY_STATE, [u("u1"), a("a1")]);
		assert.deepEqual(s.keys, ["u1", "a1"]);
	});

	it("keeps keys when ids are unchanged and a message is appended", () => {
		const s1 = nextKeyState(EMPTY_KEY_STATE, [u("u1"), a("a1")]);
		const s2 = nextKeyState(s1, [u("u1"), a("a1"), a("a2")]);
		assert.deepEqual(s2.keys, ["u1", "a1", "a2"]);
	});

	it("keeps the live message's key when its temporary id is swapped for the saved one", () => {
		const s1 = nextKeyState(EMPTY_KEY_STATE, [u("u1"), a("c_live")]);
		const s2 = nextKeyState(s1, [u("u1"), a("msg_saved")]);
		assert.deepEqual(s2.keys, ["u1", "c_live"], "same component identity: no remount");
		const s3 = nextKeyState(s2, [u("u1"), a("msg_saved"), a("next")]);
		assert.deepEqual(s3.keys, ["u1", "c_live", "next"], "the alias survives later renders");
	});

	it("pairs several swaps by role and order", () => {
		const s1 = nextKeyState(EMPTY_KEY_STATE, [u("u1"), a("c_1"), u("u2"), a("c_2")]);
		const s2 = nextKeyState(s1, [u("u1"), a("m_1"), u("u2"), a("m_2")]);
		assert.deepEqual(s2.keys, ["u1", "c_1", "u2", "c_2"]);
	});

	it("does not alias when the counts of vanished and arrived ids differ", () => {
		const s1 = nextKeyState(EMPTY_KEY_STATE, [u("u1"), a("c_live")]);
		const s2 = nextKeyState(s1, [u("u1"), a("m_1"), a("m_2")]);
		assert.deepEqual(s2.keys, ["u1", "m_1", "m_2"]);
	});

	it("never repeats a key", () => {
		const s1 = nextKeyState(EMPTY_KEY_STATE, [a("c_1")]);
		const s2 = nextKeyState(s1, [a("m_1"), a("c_1")]);
		assert.equal(new Set(s2.keys).size, 2);
	});

	it("falls back to a positional key for a message with no id", () => {
		const s = nextKeyState(EMPTY_KEY_STATE, [u(""), a("a1")]);
		assert.deepEqual(s.keys, ["m-0", "a1"]);
	});
});
