"""Tests use their own empty learned vocabulary, so a real LLM run on this machine never changes test results."""
import os, tempfile
os.environ["BIDWISE_LEARNED"] = os.path.join(tempfile.mkdtemp(prefix="bidwise_"), "vocab_learned.json")
os.environ["BIDWISE_LLM"] = "off"          # tests use fake LLM clients; never the real API
