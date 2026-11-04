import { MemoryStore } from "../../src/store/memoryStore.js";
import { runStoreContract } from "./storeContract.js";

runStoreContract("MemoryStore", () => new MemoryStore());
