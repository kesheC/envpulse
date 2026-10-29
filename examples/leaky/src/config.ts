export const config = {
  awsKey: process.env.AWS_ACCESS_KEY_ID ?? "",
  stripeKey: process.env.STRIPE_SECRET_KEY ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  email: process.env.CONTACT_EMAIL ?? "",
  port: Number(process.env.PORT ?? 8080),
};
