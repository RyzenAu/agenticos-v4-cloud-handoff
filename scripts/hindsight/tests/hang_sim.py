"""Startup-hang simulator for the supervisor's restart-bound test: behaves like an API process that
starts but never becomes healthy (it never opens its port). Used only by profile synth-hang."""
import time

print("hang_sim: pretending to start, never becoming healthy", flush=True)
while True:
    time.sleep(3600)
