// Give a post-commit FCM attempt a small response budget. The underlying SDK
// call cannot be cancelled, but it is always observed after the budget expires.
async function deliverBestEffort(attempts, waitMs = 250) {
  const delivery = Promise.allSettled(attempts.map(attempt =>
    Promise.resolve().then(attempt),
  )).then(results => {
    if (results.some(result => result.status === 'rejected' ||
        ['MESSAGING_FAILED', 'PROFILE_READ_FAILED', 'SERVICE_UNAVAILABLE'].includes(result.value?.status))) {
      console.warn('Payment notification delivery unavailable.');
    }
  });
  let timeout;
  try {
    await Promise.race([
      delivery,
      new Promise(resolve => { timeout = setTimeout(resolve, waitMs); }),
    ]);
  } catch {
    // Notification work can never turn a committed payment into an API error.
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { deliverBestEffort };
