// Skip Husky install in production, CI, or when explicitly disabled.
if (process.env.NODE_ENV === "production" || process.env.CI === "true" || process.env.HUSKY === "0") {
  process.exit(0)
}

try {
  const husky = (await import("husky")).default
  console.log(husky())
} catch (error) {
  if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
    process.exit(0)
  }

  throw error
}
