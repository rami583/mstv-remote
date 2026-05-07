export interface CompanionStatus {
  pipEnabled: boolean;
  globalMuteEnabled: boolean;
  programGuestIndexes: number[];
  programMutedGuestIndexes: number[];
  regieGuestIndexes: number[];
  regieMutedGuestIndexes: number[];
  connectedGuestCount: number;
  updatedAt: string | null;
}

const defaultCompanionStatus: CompanionStatus = {
  pipEnabled: false,
  globalMuteEnabled: false,
  programGuestIndexes: [],
  programMutedGuestIndexes: [],
  regieGuestIndexes: [],
  regieMutedGuestIndexes: [],
  connectedGuestCount: 0,
  updatedAt: null
};

declare global {
  var __mstvCompanionStatus: CompanionStatus | undefined;
}

export function getCompanionStatus() {
  return globalThis.__mstvCompanionStatus ?? defaultCompanionStatus;
}

export function setCompanionStatus(status: Omit<CompanionStatus, "updatedAt">) {
  globalThis.__mstvCompanionStatus = {
    ...status,
    updatedAt: new Date().toISOString()
  };

  return globalThis.__mstvCompanionStatus;
}
