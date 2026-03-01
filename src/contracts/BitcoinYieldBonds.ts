import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    OP_NET,
    Revert,
} from '@btc-vision/btc-runtime/runtime';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';
import { u256 } from '@btc-vision/as-bignum/assembly';

// CONSTANTS
const BLOCKS_PER_DAY:      u64 = 144;
const BLOCKS_PER_YEAR:     u64 = 52560;
const MIN_BOND_DURATION:   u64 = 144;
const MAX_BOND_DURATION:   u64 = 52560;
const PROTOCOL_FEE_BPS:    u64 = 50;
const ISSUER_PENALTY_BPS:  u64 = 1000;
const BPS_BASE:            u64 = 10000;
const MIN_COLLATERAL_PCT:  u64 = 150;

// STORAGE POINTERS
const pBondCounter:        u16 = Blockchain.nextPointer;
const pBondActive:         u16 = Blockchain.nextPointer;
const pBondMatured:        u16 = Blockchain.nextPointer;
const pBondDefaulted:      u16 = Blockchain.nextPointer;
const pBondCollateral:     u16 = Blockchain.nextPointer;
const pBondTotalSold:      u16 = Blockchain.nextPointer;
const pBondYieldPaid:      u16 = Blockchain.nextPointer;

const ppPositionActive:    u16 = Blockchain.nextPointer;
const ppPositionAmount:    u16 = Blockchain.nextPointer;
const ppPositionClaimed:   u16 = Blockchain.nextPointer;
const ppPositionEntry:     u16 = Blockchain.nextPointer;

const pIssuerReputation:   u16 = Blockchain.nextPointer;
const pIssuerBondsCount:   u16 = Blockchain.nextPointer;
const pIssuerDefaults:     u16 = Blockchain.nextPointer;

const gTokenContract:      u16 = Blockchain.nextPointer;

// EVENTS
class BondCreatedEvent extends NetEvent {
    constructor(bondId: u64, issuer: Address, amount: u64, interestRate: u64, maturityBlock: u64) {
        const w = new BytesWriter(8 + 32 + 8 + 8 + 8);
        w.writeU64(bondId);
        w.writeAddress(issuer);
        w.writeU64(amount);
        w.writeU64(interestRate);
        w.writeU64(maturityBlock);
        super('BondCreated', w);
    }
}

class BondBoughtEvent extends NetEvent {
    constructor(bondId: u64, buyer: Address, amountBTC: u64, pricePerBTC: u64) {
        const w = new BytesWriter(8 + 32 + 8 + 8);
        w.writeU64(bondId);
        w.writeAddress(buyer);
        w.writeU64(amountBTC);
        w.writeU64(pricePerBTC);
        super('BondBought', w);
    }
}

class YieldClaimedEvent extends NetEvent {
    constructor(bondId: u64, user: Address, amountYield: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(bondId);
        w.writeAddress(user);
        w.writeU64(amountYield);
        super('YieldClaimed', w);
    }
}

class BondMaturedEvent extends NetEvent {
    constructor(bondId: u64, totalYieldPaid: u64) {
        const w = new BytesWriter(8 + 8);
        w.writeU64(bondId);
        w.writeU64(totalYieldPaid);
        super('BondMatured', w);
    }
}

class BondDefaultedEvent extends NetEvent {
    constructor(bondId: u64, issuer: Address, collateralReleased: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(bondId);
        w.writeAddress(issuer);
        w.writeU64(collateralReleased);
        super('BondDefaulted', w);
    }
}

// HELPERS
function bondKey(bondId: u64): u256 {
    return u256.fromU64(bondId);
}

function positionKey(bondId: u64, user: Address): u256 {
    const buf = new Uint8Array(32);
    buf[0] = u8((bondId >> 56) & 0xff);
    buf[1] = u8((bondId >> 48) & 0xff);
    buf[2] = u8((bondId >> 40) & 0xff);
    buf[3] = u8((bondId >> 32) & 0xff);
    buf[4] = u8((bondId >> 24) & 0xff);
    buf[5] = u8((bondId >> 16) & 0xff);
    buf[6] = u8((bondId >>  8) & 0xff);
    buf[7] = u8( bondId        & 0xff);
    const addrBytes = user as Uint8Array;
    for (let i = 0; i < 24 && i < addrBytes.length; i++) {
        buf[8 + i] = addrBytes[i];
    }
    return u256.fromBytes(buf);
}

function issuerKey(issuer: Address): u256 {
    return u256.fromBytes(issuer as Uint8Array);
}

function addrToU256(addr: Address): u256 {
    return u256.fromBytes(addr as Uint8Array);
}

function u256ToAddr(val: u256): Address {
    const bytes = val.toBytes();
    const addr  = new Uint8Array(32);
    for (let i = 0; i < 32; i++) addr[i] = bytes[i];
    return changetype<Address>(addr);
}

function calculateYield(principal: u64, interestRate: u64, blockElapsed: u64): u64 {
    const numerator = principal * interestRate * blockElapsed;
    const denominator = u64(10000) * BLOCKS_PER_YEAR;
    return numerator / denominator;
}

// MAIN CONTRACT
export class BitcoinYieldBonds extends OP_NET {

    private readonly _bondCounter:      StoredMapU256;
    private readonly _bondActive:       StoredMapU256;
    private readonly _bondMatured:      StoredMapU256;
    private readonly _bondDefaulted:    StoredMapU256;
    private readonly _bondCollateral:   StoredMapU256;
    private readonly _bondTotalSold:    StoredMapU256;
    private readonly _bondYieldPaid:    StoredMapU256;

    private readonly _ppPositionActive: StoredMapU256;
    private readonly _ppPositionAmount: StoredMapU256;
    private readonly _ppPositionClaimed: StoredMapU256;
    private readonly _ppPositionEntry: StoredMapU256;

    private readonly _issuerReputation: StoredMapU256;
    private readonly _issuerBondsCount: StoredMapU256;
    private readonly _issuerDefaults:   StoredMapU256;

    private readonly _tokenContract:    StoredMapU256;

    public constructor() {
        super();
        this._bondCounter       = new StoredMapU256(pBondCounter);
        this._bondActive        = new StoredMapU256(pBondActive);
        this._bondMatured       = new StoredMapU256(pBondMatured);
        this._bondDefaulted     = new StoredMapU256(pBondDefaulted);
        this._bondCollateral    = new StoredMapU256(pBondCollateral);
        this._bondTotalSold     = new StoredMapU256(pBondTotalSold);
        this._bondYieldPaid     = new StoredMapU256(pBondYieldPaid);
        
        this._ppPositionActive  = new StoredMapU256(ppPositionActive);
        this._ppPositionAmount  = new StoredMapU256(ppPositionAmount);
        this._ppPositionClaimed = new StoredMapU256(ppPositionClaimed);
        this._ppPositionEntry   = new StoredMapU256(ppPositionEntry);

        this._issuerReputation  = new StoredMapU256(pIssuerReputation);
        this._issuerBondsCount  = new StoredMapU256(pIssuerBondsCount);
        this._issuerDefaults    = new StoredMapU256(pIssuerDefaults);

        this._tokenContract     = new StoredMapU256(gTokenContract);
    }

    public override onDeployment(_calldata: Calldata): void {
        this._bondCounter.set(u256.Zero, u256.One);
    }

    @emit('BondCreated')
    public createBond(calldata: Calldata): BytesWriter {
        const amountBTC      = calldata.readU64();
        const interestRate   = calldata.readU64();
        const durationBlocks = calldata.readU64();
        
        const issuer = Blockchain.tx.sender;
        const currentBlock = Blockchain.block.number;

        if (amountBTC == 0) throw new Revert('Amount must be > 0');
        if (interestRate > 5000) throw new Revert('Interest rate too high');
        if (durationBlocks < MIN_BOND_DURATION || durationBlocks > MAX_BOND_DURATION) {
            throw new Revert('Duration out of range');
        }

        const collateralRequired = (amountBTC * MIN_COLLATERAL_PCT) / 100;

        const tokenAddr = u256ToAddr(this._tokenContract.get(u256.Zero));
        this._transferFrom(tokenAddr, issuer, this.address, collateralRequired);

        const bondId = this._bondCounter.get(u256.Zero).toU64();
        const bKey = bondKey(bondId);
        const maturityBlock = currentBlock + durationBlocks;

        this._bondActive.set(bKey, u256.One);
        this._bondMatured.set(bKey, u256.Zero);
        this._bondDefaulted.set(bKey, u256.Zero);
        this._bondCollateral.set(bKey, u256.fromU64(collateralRequired));
        this._bondTotalSold.set(bKey, u256.Zero);
        this._bondYieldPaid.set(bKey, u256.Zero);

        const iKey = issuerKey(issuer);
        const bondsCreated = this._issuerBondsCount.get(iKey).toU64();
        this._issuerBondsCount.set(iKey, u256.fromU64(bondsCreated + 1));
        
        if (this._issuerReputation.get(iKey) == u256.Zero) {
            this._issuerReputation.set(iKey, u256.fromU64(100));
        }

        this._bondCounter.set(u256.Zero, u256.fromU64(bondId + 1));

        this.emitEvent(new BondCreatedEvent(bondId, issuer, amountBTC, interestRate, maturityBlock));

        const w = new BytesWriter(8);
        w.writeU64(bondId);
        return w;
    }

    @emit('BondBought')
    public buyBond(calldata: Calldata): BytesWriter {
        const bondId = calldata.readU64();
        const amountBTC = calldata.readU64();
        
        const buyer = Blockchain.tx.sender;
        const currentBlock = Blockchain.block.number;
        const bKey = bondKey(bondId);

        if (this._bondActive.get(bKey) != u256.One) {
            throw new Revert('Bond not active');
        }
        if (this._bondMatured.get(bKey) == u256.One) {
            throw new Revert('Bond has matured');
        }

        const maxAmount = u64(1000000000000000);
        const totalSold = this._bondTotalSold.get(bKey).toU64();
        if (totalSold + amountBTC > maxAmount) {
            throw new Revert('Not enough bond capacity');
        }

        const tokenAddr = u256ToAddr(this._tokenContract.get(u256.Zero));
        this._transferFrom(tokenAddr, buyer, this.address, amountBTC);

        const pKey = positionKey(bondId, buyer);
        this._ppPositionActive.set(pKey, u256.One);
        this._ppPositionAmount.set(pKey, u256.fromU64(amountBTC));
        this._ppPositionClaimed.set(pKey, u256.Zero);
        this._ppPositionEntry.set(pKey, u256.fromU64(currentBlock));

        this._bondTotalSold.set(bKey, u256.fromU64(totalSold + amountBTC));

        this.emitEvent(new BondBoughtEvent(bondId, buyer, amountBTC, u64(1)));

        const w = new BytesWriter(8 + 32);
        w.writeU64(bondId);
        w.writeAddress(buyer);
        return w;
    }

    @emit('YieldClaimed')
    public claimYield(calldata: Calldata): BytesWriter {
        const bondId = calldata.readU64();
        
        const user = Blockchain.tx.sender;
        const currentBlock = Blockchain.block.number;
        const bKey = bondKey(bondId);
        const pKey = positionKey(bondId, user);

        if (this._ppPositionActive.get(pKey) != u256.One) {
            throw new Revert('No position in this bond');
        }

        if (this._bondActive.get(bKey) != u256.One) {
            throw new Revert('Bond not active');
        }

        const positionAmount = this._ppPositionAmount.get(pKey).toU64();
        const entryBlock = this._ppPositionEntry.get(pKey).toU64();
        const alreadyClaimed = this._ppPositionClaimed.get(pKey).toU64();

        const blockElapsed = currentBlock - entryBlock;
        const interestRate = u64(600);
        const totalYield = calculateYield(positionAmount, interestRate, blockElapsed);
        const yieldToClaim = totalYield - alreadyClaimed;

        if (yieldToClaim == 0) {
            throw new Revert('No yield to claim');
        }

        const protocolFee = (yieldToClaim * PROTOCOL_FEE_BPS) / BPS_BASE;
        const userYield = yieldToClaim - protocolFee;

        const tokenAddr = u256ToAddr(this._tokenContract.get(u256.Zero));
        this._transfer(tokenAddr, user, userYield);

        this._ppPositionClaimed.set(pKey, u256.fromU64(alreadyClaimed + yieldToClaim));

        const totalPaid = this._bondYieldPaid.get(bKey).toU64();
        this._bondYieldPaid.set(bKey, u256.fromU64(totalPaid + yieldToClaim));

        this.emitEvent(new YieldClaimedEvent(bondId, user, userYield));

        const w = new BytesWriter(8);
        w.writeU64(userYield);
        return w;
    }

    public getBondInfo(calldata: Calldata): BytesWriter {
        const bondId = calldata.readU64();
        const bKey = bondKey(bondId);

        const isActive = this._bondActive.get(bKey) == u256.One;
        const isMatured = this._bondMatured.get(bKey) == u256.One;
        const isDefaulted = this._bondDefaulted.get(bKey) == u256.One;
        const collateral = this._bondCollateral.get(bKey).toU64();
        const totalSold = this._bondTotalSold.get(bKey).toU64();
        const yieldPaid = this._bondYieldPaid.get(bKey).toU64();

        const w = new BytesWriter(8 + 8 + 8 + 8 + 3);
        w.writeU64(bondId);
        w.writeU64(collateral);
        w.writeU64(totalSold);
        w.writeU64(yieldPaid);
        w.writeBoolean(isActive);
        w.writeBoolean(isMatured);
        w.writeBoolean(isDefaulted);
        return w;
    }

    public getPositionInfo(calldata: Calldata): BytesWriter {
        const bondId = calldata.readU64();
        const user = calldata.readAddress();

        const pKey = positionKey(bondId, user);
        const isActive = this._ppPositionActive.get(pKey) == u256.One;
        const amount = this._ppPositionAmount.get(pKey).toU64();
        const claimed = this._ppPositionClaimed.get(pKey).toU64();
        const entryBlock = this._ppPositionEntry.get(pKey).toU64();

        const blockElapsed = Blockchain.block.number - entryBlock;
        const interestRate = u64(600);
        const totalYield = calculateYield(amount, interestRate, blockElapsed);
        const accrued = totalYield - claimed;

        const w = new BytesWriter(8 + 8 + 8 + 8 + 1);
        w.writeU64(amount);
        w.writeU64(claimed);
        w.writeU64(accrued);
        w.writeU64(blockElapsed);
        w.writeBoolean(isActive);
        return w;
    }

    private _transferFrom(token: Address, from: Address, to: Address, amount: u64): void {
        const data = new BytesWriter(4 + 32 + 32 + 32);
        data.writeSelector(0x4b6685e7);
        data.writeAddress(from);
        data.writeAddress(to);
        data.writeU256(u256.fromU64(amount));
        const result = Blockchain.call(token, data);
        if (!result.success) throw new Revert('transferFrom failed');
    }

    private _transfer(token: Address, to: Address, amount: u64): void {
        const data = new BytesWriter(4 + 32 + 32);
        data.writeSelector(0x3b88ef57);
        data.writeAddress(to);
        data.writeU256(u256.fromU64(amount));
        const result = Blockchain.call(token, data);
        if (!result.success) throw new Revert('transfer failed');
    }
}
