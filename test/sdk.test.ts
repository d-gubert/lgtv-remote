import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { delay } from "./contract/client.js";
import { startFakeTv, type FakeTv } from "./fake-tv.js";
import {
  connect,
  LaunchPoints,
  optional,
  PointerSocket,
  string,
  struct,
  VolumeStatus,
  type Connection,
} from "../src/sdk/index.js";

/**
 * The SDK's own tests: what makes it worth having as a separate thing at all.
 *
 * Its *protocol* behaviour is not here — that is `test/contract.test.ts`, which
 * holds it and the Effect binding to one description. What is here is the
 * independence itself, and the two surfaces the contract seam cannot express
 * because they have no Effect counterpart: the decoders, and subscriptions as
 * an async iterable.
 */

describe("independence", () => {
  const sdk = new URL("../src/sdk/", import.meta.url).pathname;

  /**
   * Every import specifier under `src/sdk`, by file. Comments are stripped
   * first, or the usage example in `index.ts` reads as a dependency.
   */
  const specifiers = async (): Promise<
    ReadonlyArray<[string, ReadonlyArray<string>]>
  > => {
    const files = (await readdir(sdk)).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length >= 6, "expected to have found the SDK's sources");
    return Promise.all(
      files.map(async (file): Promise<[string, ReadonlyArray<string>]> => {
        const source = await readFile(join(sdk, file), "utf8");
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return [
          file,
          [...code.matchAll(/from\s+"([^"]+)"/g)].map(([, name]) => name ?? ""),
        ];
      }),
    );
  };

  it("imports nothing from effect, anywhere under src/sdk", async () => {
    const offenders = (await specifiers())
      .filter(([, imports]) =>
        imports.some(
          (name) => name === "effect" || name.startsWith("@effect/"),
        ),
      )
      .map(([file]) => file);

    assert.deepEqual(
      offenders,
      [],
      "src/sdk must run without effect installed",
    );
  });

  it("reaches into no other part of this repository", async () => {
    const offenders = (await specifiers())
      .filter(([, imports]) => imports.some((name) => name.startsWith("../")))
      .map(([file]) => file);

    assert.deepEqual(
      offenders,
      [],
      "the SDK has to be liftable out of the CLI as it stands",
    );
  });

  it("depends on `ws` and nothing else", async () => {
    const external = new Set(
      (await specifiers()).flatMap(([, imports]) =>
        imports.filter((name) => !name.startsWith(".")),
      ),
    );
    assert.deepEqual([...external].sort(), ["ws"]);
  });
});

describe("decoders", () => {
  it("accepts a reply that carries more than it was asked about", () => {
    const decoded = VolumeStatus.decode({
      volume: 12,
      somethingNewInWebOS26: true,
    });
    assert.deepEqual(decoded, { ok: true, value: { volume: 12 } });
  });

  it("treats an absent optional field as absent, not as undefined", () => {
    const decoded = VolumeStatus.decode({});
    assert.equal(decoded.ok, true);
    if (decoded.ok) {
      assert.deepEqual(
        Object.keys(decoded.value),
        [],
        "an absent field must not be materialised",
      );
    }
  });

  it("reads an explicit null as absent, the way webOS means it", () => {
    const decoded = VolumeStatus.decode({ volume: 5, muted: null });
    assert.deepEqual(decoded, { ok: true, value: { volume: 5 } });
  });

  it("rejects a missing required field, and says which", () => {
    const decoded = PointerSocket.decode({ returnValue: true });
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.reason, "socketPath: is missing");
  });

  it("rejects a required field of the wrong type, and says what it got", () => {
    const decoded = PointerSocket.decode({ socketPath: 42 });
    assert.equal(decoded.ok, false);
    if (!decoded.ok)
      assert.equal(decoded.reason, "socketPath: expected string, got number");
  });

  it("points at the element inside a list that failed", () => {
    const decoded = LaunchPoints.decode({
      launchPoints: [{ id: "netflix" }, { title: "no id here" }],
    });
    assert.equal(decoded.ok, false);
    if (!decoded.ok)
      assert.equal(decoded.reason, "launchPoints[1].id: is missing");
  });

  it("nests the path through structs", () => {
    const decoded = struct({
      outer: struct({ inner: optional(string) }),
    }).decode({
      outer: { inner: 1 },
    });
    assert.equal(decoded.ok, false);
    if (!decoded.ok)
      assert.equal(decoded.reason, "outer.inner: expected string, got number");
  });

  it("rejects a payload that is not an object at all", () => {
    assert.equal(VolumeStatus.decode("nope").ok, false);
    assert.equal(VolumeStatus.decode(null).ok, false);
    assert.equal(VolumeStatus.decode([]).ok, false);
  });
});

describe("updates()", () => {
  const URI = "ssap://audio/getVolume";
  let tv: FakeTv;
  let connection: Connection;

  beforeEach(async () => {
    tv = await startFakeTv();
    connection = await connect({
      host: tv.host,
      port: tv.port,
      timeoutMs: 1000,
    });
  });

  afterEach(async () => {
    await connection.close();
    await tv.close();
  });

  it("iterates the immediate reply and then every push", async () => {
    const seen: Array<unknown> = [];
    const stream = connection.updates(URI);

    const consumer = (async () => {
      for await (const update of stream) {
        seen.push(update.volume);
        if (seen.length === 3) break;
      }
    })();

    await delay(60);
    tv.pushVolume(40);
    await delay(30);
    tv.pushVolume(41);
    await consumer;

    assert.deepEqual(seen, [12, 40, 41]);
  });

  it("buffers updates that arrive while nothing is awaiting", async () => {
    const stream = connection.updates(URI);
    // Nobody is iterating yet: these have to queue rather than vanish.
    await delay(60);
    tv.pushVolume(70);
    tv.pushVolume(71);
    await delay(30);

    const seen: Array<unknown> = [];
    for await (const update of stream) {
      seen.push(update.volume);
      if (seen.length === 3) break;
    }
    assert.deepEqual(seen, [12, 70, 71]);
  });

  it("stops listening when the loop is broken out of", async () => {
    const stream = connection.updates(URI);
    for await (const update of stream) {
      void update; // one update is enough; break to prove the loop cleans up
      break;
    }

    tv.pushVolume(99);
    await delay(50);

    const status = await connection.request(URI);
    assert.equal(status.volume, 99, "the connection should still be healthy");
  });

  it("ends the loop rather than hanging when the socket dies", async () => {
    const stream = connection.updates(URI);
    const seen: Array<unknown> = [];

    const consumer = (async () => {
      for await (const update of stream) seen.push(update.volume);
    })();

    await delay(60);
    tv.dropConnections();

    await assert.rejects(consumer, /could not reach/);
    assert.deepEqual(
      seen,
      [12],
      "the update that did arrive is still delivered",
    );
  });
});
