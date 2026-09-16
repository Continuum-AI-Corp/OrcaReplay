"""A Haystack RAG pipeline: embed the documents, embed the query, retrieve, then answer.

Separate from `haystack_pipeline.py` because it exercises a different half of capture. The chat
call goes to the proxy as a model exchange; the two embedding calls are *retrieval* calls — an
endpoint whose answer is a function of its request — and are replayed by looking that key up rather
than by the matching ladder. A pipeline that embeds at query time is the ordinary RAG shape, and
without this nothing proved it replays.
"""
from haystack import Document, Pipeline
from haystack.components.builders import ChatPromptBuilder
from haystack.components.embedders import OpenAIDocumentEmbedder, OpenAITextEmbedder
from haystack.components.generators.chat import OpenAIChatGenerator
from haystack.components.retrievers.in_memory import InMemoryEmbeddingRetriever
from haystack.dataclasses import ChatMessage
from haystack.document_stores.in_memory import InMemoryDocumentStore

store = InMemoryDocumentStore()
docs = [Document(content="Paris is the capital of France."),
        Document(content="Berlin is the capital of Germany.")]
emb = OpenAIDocumentEmbedder(model="text-embedding-3-small")
store.write_documents(emb.run(documents=docs)["documents"])

p = Pipeline()
p.add_component("q_emb", OpenAITextEmbedder(model="text-embedding-3-small"))
p.add_component("retriever", InMemoryEmbeddingRetriever(document_store=store, top_k=1))
p.add_component("prompt", ChatPromptBuilder(
    template=[ChatMessage.from_user("Context: {{docs[0].content}}\nQ: {{q}}")],
    required_variables=["docs", "q"]))
p.add_component("llm", OpenAIChatGenerator(model="stub-1"))
p.connect("q_emb.embedding", "retriever.query_embedding")
p.connect("retriever.documents", "prompt.docs")
p.connect("prompt.prompt", "llm.messages")

r = p.run({"q_emb": {"text": "capital of France"}, "prompt": {"q": "capital of France?"}})
print("GOT:", r["llm"]["replies"][0].text)
