import { expect, test } from "bun:test"
import plugin from "../index.ts"

test("the local directory entry imports the current V2 plugin", () => {
  expect(plugin.id).toBe("opencode-recall")
  expect(typeof plugin.setup).toBe("function")
})
