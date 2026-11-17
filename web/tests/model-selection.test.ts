import { afterAll, expect, test } from "bun:test";
import type { AiConfig, ModelCapability } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
afterAll(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { CONFIG_STORE_KEY, configWithoutTemporaryKeys, defaultConfig, resolveModelForCapability, upsertChannelCredentials, useConfigStore } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

const config: AiConfig = {
    ...defaultConfig,
    videoModel: "replacement::video-b",
    channels: [
        {
            id: "replacement",
            name: "Replacement",
            baseUrl: "https://example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: [
                { name: "video-b", capability: "video" },
                { name: "video-a", capability: "video" },
                { name: "image-a", capability: "image" },
            ],
        },
    ],
};
const ready = useConfigStore.getState().isAiConfigReady;
const videoNode = (model: string): CanvasNodeData => ({
    id: "saved-video",
    type: CanvasNodeType.Video,
    title: "Saved video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { model, videoTaskId: "original-task", videoTaskProvider: "openai", seconds: "4" },
});

test("a saved video on a removed provider is not replaced by the default video model", () => {
    const selected = buildGenerationConfig(config, videoNode("removed::video-a"), "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("removing a model from an existing provider prevents retry even with valid credentials", () => {
    const selected = buildGenerationConfig(config, videoNode("replacement::deleted-video"), "video");
    expect(selected.model).toBe("replacement::deleted-video");
    expect(ready(selected, selected.model)).toBe(false);
});

test("task recovery rejects a missing provider instead of querying the first provider", () => {
    expect(ready(config, "removed::video-a")).toBe(false);
    expect(ready(config, "unknown-video")).toBe(false);
});

test("an explicitly selected unavailable default is not replaced by the built-in default", () => {
    const selected = buildGenerationConfig({ ...config, videoModel: "removed::video-a" }, undefined, "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("a new node without a selection still uses its configured default", () => {
    const selected = buildGenerationConfig(config, undefined, "video");
    expect(selected.model).toBe("replacement::video-b");
    expect(ready(selected, selected.model)).toBe(true);
});

test("switching generation capability still selects a model of the new capability", () => {
    expect(resolveModelForCapability(config, "replacement::image-a", "video")).toBe("replacement::video-b");
});

test("changing only the key on the same provider preserves the saved model and task", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig({ ...config, channels: [{ ...config.channels[0], apiKey: "rotated-key" }] }, node, "video");
    expect(selected.model).toBe("replacement::video-a");
    expect(ready(selected, selected.model)).toBe(true);
    expect(node.metadata?.videoTaskId).toBe("original-task");
    expect(ready({ ...selected, channels: [{ ...config.channels[0], apiKey: "" }] }, selected.model)).toBe(false);
});

test("unavailable explicit selections are preserved for every generation capability", () => {
    for (const capability of ["image", "video", "text", "audio"] as ModelCapability[]) {
        expect(resolveModelForCapability(config, `removed::${capability}`, capability)).toBe(`removed::${capability}`);
    }
});

test("musketeer links import only the gateway address and preserve an existing manual key", () => {
    const input = { baseUrl: "https://api.monkeykgai.com/v1/", apiKey: "key-from-url" };
    const imported = upsertChannelCredentials(config, input);
    const channel = imported.config.channels[1];
    expect(channel).toMatchObject({ name: "musketeer", apiKey: "", rememberApiKey: false });
    const configured = { ...imported.config, channels: [config.channels[0], { ...channel, apiKey: "manual-key", rememberApiKey: true }] };
    const reopened = upsertChannelCredentials(configured, { ...input, baseUrl: "https://api.monkeykgai.com/" });
    expect(reopened.config.channels).toHaveLength(2);
    expect(reopened.config.channels[1]).toMatchObject({ apiKey: "manual-key", rememberApiKey: true });
});

test("temporary keys remain in memory and are removed from persistence and config export", async () => {
    const original = useConfigStore.getState().config;
    const provider = { ...config.channels[0], apiKey: "temporary-key", rememberApiKey: false };
    const next = { ...config, apiKey: provider.apiKey, channels: [provider, { ...config.channels[0], id: "legacy" }] };
    try {
        useConfigStore.setState({ config: next });
        expect(useConfigStore.getState().config.channels[0].apiKey).toBe("temporary-key");
        const exported = configWithoutTemporaryKeys(next);
        expect(exported.apiKey).toBe("");
        expect(exported.channels.map(({ apiKey }) => apiKey)).toEqual(["", "test-key"]);
        const stored = JSON.parse(values.get(CONFIG_STORE_KEY)!).state.config as AiConfig;
        expect(stored.apiKey).toBe("");
        expect(stored.channels.map(({ apiKey }) => apiKey)).toEqual(["", "test-key"]);
        useConfigStore.setState({ config: { ...next, channels: [{ ...provider, rememberApiKey: true }] } });
        await useConfigStore.persist.rehydrate();
        expect(useConfigStore.getState().config.channels[0].apiKey).toBe("temporary-key");
    } finally {
        useConfigStore.setState({ config: original });
    }
});
