"""LlamaIndex's own OpenAI LLM, which reads the older base-URL variable and not the new one.

Worth a check rather than a claim, and for a sharper reason than most of this corpus. LlamaIndex
does not read `OPENAI_BASE_URL` at all — measured, not assumed:

    OPENAI_BASE_URL set   →  client.base_url == https://api.openai.com/v1/     (ignored)
    OPENAI_API_BASE set   →  client.base_url == http://127.0.0.1:8888/v1/      (honoured)

`generic-openai` happens to set both, with a comment saying pre-1.0 SDKs and ports need the older
name. This check is what turns that comment into something that fails when it stops being true:
drop `OPENAI_API_BASE` from the adapter and every other check here still passes, because every
other framework reads the new name.

The model name is a real one rather than `stub-1` because LlamaIndex refuses anything outside its
own built-in list — `ValueError: Unknown model 'stub-1'`, raised from `openai_modelname_to_contextsize`
before a request is ever made, and there is no `context_window` argument to bypass it. That is a
property of LlamaIndex, not of orca, and `llama_index_model_names.py` is what stops the claim
drifting. The stub echoes whatever model it is given, so the name changes nothing here.
"""

from llama_index.core.llms import ChatMessage
from llama_index.llms.openai import OpenAI

llm = OpenAI(model="gpt-4o-mini")
print("base_url:", llm._get_client().base_url)
reply = llm.chat([ChatMessage(role="user", content="hello")])
print("GOT:", reply.message.content)
