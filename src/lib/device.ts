import { prisma } from './prisma.js';

export async function ensureDevice(deviceId: string, label: string): Promise<void> {
  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { deviceId: true },
  });
  if (!device) {
    await prisma.device.upsert({
      where: { deviceId },
      update: {},
      create: { deviceId },
    });
    console.log(`[${label}] Auto-registered device`, { deviceId });
  }
}
