// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { expect, test } from "bun:test";
import { isEmbeddingModel } from "./business-ask";

test("embedding and reranking models are never chat choices; chat models are", () => {
  for (const name of ["nomic-embed-text", "text-embedding-3-small", "bge-m3", "all-MiniLM-L6-v2", "e5-large", "bge-reranker-v2"]) expect(isEmbeddingModel(name)).toBe(true);
  for (const name of ["llama3.2", "qwen2.5-coder:7b", "gpt-5", "claude-sonnet-5-5", "gemma3"]) expect(isEmbeddingModel(name)).toBe(false);
});
