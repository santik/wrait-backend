import { prisma } from './prisma.js';

export type EnsuredDevice = {
  deviceId: string;
  dailyRecordLimit: number | null;
};

export async function ensureDevice(deviceId: string): Promise<EnsuredDevice> {
  return prisma.device.upsert({
    where: { deviceId },
    update: {},
    create: { deviceId },
    select: {
      deviceId: true,
      dailyRecordLimit: true,
    },
  });
}
