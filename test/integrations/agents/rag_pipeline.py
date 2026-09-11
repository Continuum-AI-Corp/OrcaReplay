"""A retrieval pipeline in miniature: index with embeddings, then answer with chat.

Not a toy of a framework but a reduction of one. Every index-building RAG stack — IndexRAG,
LlamaIndex, Microsoft GraphRAG, LightRAG — has this shape, and it is the shape orca had no answer
for: a batch of concurrent chat calls whose varying part is the *system* prompt, followed by an
embedding call that no wire dialect claims, followed by a question answered over what came back.

Three things here exist to be checked and nothing else:

* **`--concurrency` with the document in the system prompt.** Every request's only message is the
  same instruction, so before the matcher was fixed a replay handed each document another
  document's extraction and still exited 0.
* **An embedding batch assembled in completion order.** The worker pool finishes in whatever order
  it finishes, so the same texts reach `/v1/embeddings` in a different sequence every run — which
  is why a recorded retrieval call has to be findable by more than its exact bytes.
* **A `Context: … Question: …` prompt**, so `retrieval.context` has something to derive from.
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

from openai import OpenAI

DOCUMENTS = [
    "Marie Curie was born in Warsaw in 1867 and won two Nobel Prizes.",
    "Pierre Curie was born in Paris in 1859 and shared the 1903 Nobel Prize in Physics.",
    "The Sorbonne was founded in 1253 by Robert de Sorbon, in the Latin Quarter of Paris.",
    "Radioactivity was named by Marie Curie, who studied it at the Sorbonne.",
]

QUESTION = "Where was Marie Curie born?"

chat = OpenAI()
# The embedding half may be pointed somewhere else entirely — that is the ordinary shape of a
# retrieval stack, and the one an upstream map keyed by wire dialect cannot express.
embed = OpenAI(base_url=os.environ.get("EMBEDDING_BASE_URL") or str(chat.base_url))


def extract(document: str) -> str:
    """One indexing call. The document is in the system prompt; the message never varies."""
    reply = chat.chat.completions.create(
        model="stub-1",
        messages=[
            {"role": "system", "content": f"Extract the facts from:\n\n{document}"},
            {"role": "user", "content": "Return the facts as JSON."},
        ],
        temperature=0,
    )
    return reply.choices[0].message.content


# Completion order, not submission order: this is what makes the batch below differ run to run.
facts = []
with ThreadPoolExecutor(max_workers=4) as pool:
    futures = [pool.submit(extract, d) for d in DOCUMENTS]
    for future in as_completed(futures):
        facts.append(future.result())

vectors = embed.embeddings.create(model="stub-embedding", input=facts)
if len(vectors.data) != len(facts):
    print(f"embedding returned {len(vectors.data)} vectors for {len(facts)} inputs")
    sys.exit(2)

# One more embedding, for the question — a single input, which has no order to differ in.
asked = embed.embeddings.create(model="stub-embedding", input=[QUESTION])

context = "\n\n---\n\n".join(facts)
answer = chat.chat.completions.create(
    model="stub-1",
    messages=[
        {"role": "system", "content": "Answer from the context."},
        {"role": "user", "content": f"Context:\n{context}\n\nQuestion: {QUESTION}\n\nAnswer:"},
    ],
    temperature=0,
)

print("indexed:", len(vectors.data), "dims:", len(asked.data[0].embedding))
print("GOT:", answer.choices[0].message.content)
