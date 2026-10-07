import type { Pack } from "@gauntlet/core"
import { clojurePack } from "@gauntlet/pack-clojure"
import { goPack } from "@gauntlet/pack-go"
import { jvmPack } from "@gauntlet/pack-jvm"
import { pythonPack } from "@gauntlet/pack-python"
import { rustPack } from "@gauntlet/pack-rust"
import { scalaPack } from "@gauntlet/pack-scala"
import { typescriptPack } from "@gauntlet/pack-typescript"

/** Packs compiled into this binary (ADR 0006). */
export const INSTALLED_PACKS: ReadonlyArray<Pack> = [jvmPack, typescriptPack, pythonPack, goPack, rustPack, scalaPack, clojurePack]
