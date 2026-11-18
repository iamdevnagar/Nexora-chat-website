import "dotenv/config";
import { prisma } from "../server/db.js";

const username = process.argv[2]?.toLowerCase();
if (!username) {
  console.error("Usage: npm run admin:promote -- <username>");
  process.exitCode = 1;
} else {
  try {
    const user = await prisma.user.update({
      where: { username },
      data: { isAdmin: true },
      select: { username: true, isAdmin: true },
    });
    console.log(`Administrator access enabled for @${user.username}.`);
  } catch (error) {
    if (error.code === "P2025") {
      console.error(`No account found for @${username}. Register the account first.`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    await prisma.$disconnect();
  }
}
