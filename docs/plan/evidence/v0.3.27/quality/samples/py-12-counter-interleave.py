# Sample py-12 — race (defect)
# The read-modify-write of the shared counter is not atomic across the await:
# concurrent tasks both read the same value and one increment is lost.
import asyncio

requests_served = 0


async def handle(request_id: int) -> None:
    global requests_served
    current = requests_served
    await asyncio.sleep(0)
    requests_served = current + 1
