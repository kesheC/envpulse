import os
import sys

target = os.environ["DEPLOY_TARGET"]
timeout = int(os.getenv("HEALTHCHECK_TIMEOUT", "5"))
sys.stdout.write(f"{target} {timeout}\n")
