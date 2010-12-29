var FLAGN = 8;
var FLAGZ = 4;
var FLAGV = 2;
var FLAGC = 1;

var pr = false;
var R = [0, 0, 0, 0, 0, 0, 0, 0]; // registers
var KSP = 0; // kernel stack pointer
var PS = 0; // processor status
var curPC = 0; // address of current instruction
var instr = 0; // current instruction
var memory = new Array(128*1024); // word addressing
var tim1, tim2;
var ips;
var SR0;
var Page = {
	par : 0,
	pdr : 0,
	addr : 0,
	len : 0,
	read : 0,
	write : 0,
	ed : 0,
};

var pages = new Array(16);

var bootrom = [
    0042113,                        /* "KD" */
    0012706, 02000,                 /* MOV #boot_start, SP */
    0012700, 0000000,               /* MOV #unit, R0        ; unit number */
    0010003,                        /* MOV R0, R3 */
    0000303,                        /* SWAB R3 */
    0006303,                        /* ASL R3 */
    0006303,                        /* ASL R3 */
    0006303,                        /* ASL R3 */
    0006303,                        /* ASL R3 */
    0006303,                        /* ASL R3 */
    0012701, 0177412,               /* MOV #RKDA, R1        ; csr */
    0010311,                        /* MOV R3, (R1)         ; load da */
    0005041,                        /* CLR -(R1)            ; clear ba */
    0012741, 0177000,               /* MOV #-256.*2, -(R1)  ; load wc */
    0012741, 0000005,               /* MOV #READ+GO, -(R1)  ; read & go */
    0005002,                        /* CLR R2 */
    0005003,                        /* CLR R3 */
    0012704, 02020,                 /* MOV #START+20, R4 */
    0005005,                        /* CLR R5 */
    0105711,                        /* TSTB (R1) */
    0100376,                        /* BPL .-2 */
    0105011,                        /* CLRB (R1) */
    0005007                         /* CLR PC */
    ];

function
xor(a,b)
{
	return (a || b) && !(a && b);
}

function
physread16(a)
{
	if(a % 1) panic("read from odd address " + ostr(a,6));
	if(a < 0760000) return memory[a>>1];
	if(a == 0777776) return PS;
	if((a & 0777770) == 0777560) return consread16(a);
	if((a & 0777760) == 0777400) return rkread16(a);
	if((a & 0777600) == 0772200) return mmuread16(a);
	panic("read from invalid address " + ostr(a,6));
}

function
physread8(a)
{
	var val;
	val = physread16(a & ~1);
	if(a & 1) return val >> 8;
	return val & 0xFF;
}

function
physwrite8(a,v)
{
	if(a < 0760000) {
		if(a & 1) {
			memory[a>>1] &= 0xFF;
			memory[a>>1] |= (v & 0xFF) << 8;
		} else {
			memory[a>>1] &= 0xFF00;
			memory[a>>1] |= v & 0xFF;
		}
	} else {
		if(a & 1) {
			physwrite16(a&~1, (physread16(a) & 0xFF) | ((v & 0xFF) << 8));
		} else {
			physwrite16(a&~1, (physread16(a) & 0xFF00) | (v & 0xFF));
		}
	}
}

function
physwrite16(a,v)
{
	if(a % 1) panic("write to odd address " + ostr(a,6));
	if(a < 0760000) memory[a>>1] = v;
	else if(a == 0777776) PS = v;
	else if((a & 0777770) == 0777560) conswrite16(a,v);
	else if((a & 0777700) == 0777400) rkwrite16(a,v);
	else if((a & 0777600) == 0772200) mmuwrite16(a,v);
	else panic("write to invalid address " + ostr(a,6));
}

function
decode(a,w)
{
	var p, user, block, disp;
	if(!(SR0 & 1)) {
		if(a >= 0170000) a += 0600000;
		return a;
	}
	user = 0; // FIXME for user mode
	p = pages[(a >> 12) + user];
	if(w && !p.write) panic("write to read-only page " + ostr(a,6));
	if(!p.read) panic("read from no-access page " + ostr(a,6));
	block = (a >> 6) & 0177;
	disp = a & 077;
	if(p.ed) {
		if((127 - block) > p.len) panic("page length exceeded " + ostr(a,6));
	} else {
		if(block > p.len) panic("page length exceeded " + ostr(a,6))
	}
	if(w) p.pdr |= 1<<6;
	return ((block + p.addr) << 6) + disp;
}

function
createpage(par,pdr)
{
	var p;
	p = new(Page);
	p.par = par;
	p.pdr = pdr;
	p.addr = par & 07777;
	p.len = (pdr >> 8) & 0x7F;
	p.ed = (pdr & 8) == 8;
	p.read = (pdr & 2) == 2;
	p.write = (pdr & 6) == 6;
	return p;
}

function
mmuread16(a)
{
	panic("read from invalid address " + ostr(a,6));
}

function
mmuwrite16(a, v)
{
	var i;
	i = (a & 017)>>1;
	if((a >= 0772300) && (a < 0772320)) {
		pages[i] = createpage(pages[i].par, v);
	}
	if((a >= 0772340) && (a < 0772360)) {
		pages[i] = createpage(v, pages[i].pdr);
	}
	panic("write to invalid address " + ostr(a,6));
}

function
read8(a)
{
	return physread8(decode(a, false));
}

function
read16(a)
{
	return physread16(decode(a, false));
}

function
write8(a, v)
{
	return physwrite8(decode(a, false),v);
}

function
write16(a, v)
{
	return physwrite16(decode(a, false),v);
}

function
fetch16()
{
	var val;
	val = read16(R[7]);
	R[7] += 2;
	return val;
}

function
push(v)
{
	R[6] -= 2;
	write16(R[6], v);
}

function
pop(v)
{
	var val;
	val = read16(R[6], v);
	R[6] += 2;
	return val;
}

function
ostr(z,n)
{
	var val;
	val = z.toString(8);
	while(val.length < n)
		val = "0"+val;
	return val;
}

function
cleardebug()
{
	var len = document.getElementById("debug").firstChild.nodeValue.length;
	document.getElementById("debug").firstChild.deleteData(0, len);
}

function
writedebug(msg)
{
	document.getElementById("debug").firstChild.appendData(msg);
}

function
printstate()
{
	writedebug(
		"R0 " + ostr(R[0],6) + " " + 
		"R1 " + ostr(R[1],6) + " " + 
		"R2 " + ostr(R[2],6) + " " + 
		"R3 " + ostr(R[3],6) + " " + 
		"R4 " + ostr(R[4],6) + " " + 
		"R5 " + ostr(R[5],6) + " " + 
		"R6 " + ostr(R[6],6) + " " + 
		"R7 " + ostr(R[7],6)
	+ "\n[");
	if(PS & FLAGN) writedebug("N"); else writedebug(" ");
	if(PS & FLAGZ) writedebug("Z"); else writedebug(" ");
	if(PS & FLAGV) writedebug("V"); else writedebug(" ");
	if(PS & FLAGC) writedebug("C"); else writedebug(" ");
	writedebug("]  instr " + ostr(curPC,6) + ": " + ostr(instr,6)+"   " + disasm(curPC) + "\n\n");
}

function
panic(msg)
{
	writedebug(msg+"\n");
	printstate();
	stop();
	throw msg;
}

function
aget(v, l)
{
	var addr;
	if((v & 7) == 6 || (v & 010)) l = 2;
	if((v & 070) == 000) {
		return -(v + 1);
	}
	switch(v & 060) {
	case 000:
		v &= 7;
		addr = R[v & 7];
		break;
	case 020:
		addr = R[v & 7];
		R[v & 7] += l;
		break;1
	case 040:
		R[v & 7] -= l;
		addr = R[v & 7];
		break;
	case 060:
		addr = read16();
		addr += R[v & 7];
		break;
	}
	addr &= 0xFFFF;
	if(v & 010) {
		addr = read16(addr);
	}
	return addr;
}

function
memread(a, l)
{
	if(a < 0) {
		if(l == 2)
			return R[-(a + 1)];
		else
			return R[-(a + 1)] & 0xFF;
	}
	if(l == 2)
		return read16(a);
	return read8(a);
}

function
memwrite(a, l, v)
{
	if(a < 0) {
		if(l == 2)
			R[-(a + 1)] = v;
		else {
			R[-(a + 1)] &= 0xFF00;
			R[-(a + 1)] |= v;
		}
	} else if(l == 2)
		write16(a, v);
	else
		write8(a, v);
}

function
branch(o)
{
	if(o & 0x80) {
		o = -(((~o)+1)&0xFF);
	}
	o <<= 1;
	R[7] += o;
}

function
step()
{
	var val, val1, val2, da, sa, d, s, l, r;
	ips++;
	curPC = R[7];
	instr = fetch16();
	d = instr & 077;
	s = (instr & 07700) >> 6;
	l = 2 - (instr >> 15);
	o = instr & 0xFF;
	if(l == 2) {
		max = 0xFFFF;
		maxp = 0x7FFF;
		msb = 0x8000;
	}
	else {
		max = 0xFF;
		maxp = 0x7F;
		msb = 0x80;
	}
	switch(instr & 0070000) {
	case 0010000: // MOV
		sa = aget(s, l); val = memread(sa, l);
		da = aget(d, l);
		PS &= 0xFFF1;
		if(val & msb) PS |= FLAGN;
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0020000: // CMP
		sa = aget(s, l); val1 = memread(sa, l);
		da = aget(d, l); val2 = memread(da, l);
		val = (val1 - val2) & max;
		PS &= 0xFFF0;
		if(val == 0) PS |= FLAGZ;
		if(val & msb) PS |= FLAGN;
		if(((val1 ^ val2) & msb) && !((val2 ^ val) & msb)) PS |= FLAGV;
		if(val1 < val2) PS |= FLAGC;
		return;
	case 0030000: // BIT
		sa = aget(s, l); val1 = memread(sa, l);
		da = aget(d, l); val2 = memread(da, l);
		val = val1 & val2;
		PS &= 0xFFF1;
		if(val == 0) PS |= FLAGZ;
		if(val & msb) PS |= FLAGN;
		return;
	case 0040000: // BIC
		sa = aget(s, l); val1 = memread(sa, l);
		da = aget(d, l); val2 = memread(da, l);
		val = (max ^ val1) & val2;
		PS &= 0xFFF1;
		if(val == 0) PS |= FLAGZ;
		if(val & msb) PS |= FLAGN;
		memwrite(da, l, val);
		return;
	case 0050000: // BIS
		sa = aget(s, l); val1 = memread(sa, l);
		da = aget(d, l); val2 = memread(da, l);
		val = val1 | val2;
		PS &= 0xFFF1;
		if(val == 0) PS |= FLAGZ;
		if(val & msb) PS |= FLAGN;
		memwrite(da, l, val);
		return;
	}
	switch(instr & 0170000) {
	case 0060000: // ADD
		sa = aget(s, 2); val1 = memread(sa, 2);
		da = aget(d, 2); val2 = memread(da, 2);
		val = (val1 + val2) & 0xFFFF;
		PS &= 0xFFF0;
		if(val == 0) PS |= FLAGZ;
		if(val & 0x8000) PS |= FLAGN;
		if(!((val1 ^ val2) & 0x8000) && ((val2 ^ val) & 0x8000)) PS |= FLAGV;
		if(val1 + val2 >= 0xFFFF) PS |= FLAGC;
		memwrite(da, 2, val);
		return;
	case 0160000: // SUB
		sa = aget(s, 2); val1 = memread(sa, 2);
		da = aget(d, 2); val2 = memread(da, 2);
		val = (val1 - val2) & 0xFFFF;
		PS &= 0xFFF0;
		if(val == 0) PS |= FLAGZ;
		if(val & 0x8000) PS |= FLAGN;
		if(((val1 ^ val2) & 0x8000) && !((val2 ^ val) & 0x8000)) PS |= FLAGV;
		if(val1 >= val2) PS |= FLAGC;
		memwrite(da, 2, val);
		return;
	}
	switch(instr & 0177000) {
	case 0004000: // JSR
		val = aget(d, l);
		if(val < 0) break;
		push(R[s & 7]);
		R[s & 7] = R[7];
		R[7] = val;
		return;
	case 0071000: // DIV
		val1 = R[s & 7] | (R[(s & 7) + 1] << 8);
		da = aget(d, l); val2 = memread(da, 2);
		PS &= 0xFFF0;
		if(val2 == 0) {
			PS |= FLAGC;
			return;
		}
		R[s & 7] = (val1 / val2) & 0xFFFF;
		R[(s & 7) + 1] = (val1 % val2) & 0xFFFF;
		if(R[s & 7] == 0) PS |= FLAGZ;
		if(R[s & 7] & 0100000) PS |= FLAGN;
		if(val1 == 0) PS |= FLAGV;
		return;
	case 0072000: // ASH
		val1 = R[s & 7];
		da = aget(d, 2); val2 = memread(da, 2) & 077;
		PS &= 0xFFF0;
		if(val & 040) {
			val2 = (077 ^ val2) + 1;
			if(val1 & 0100000) {
				val = 0xFFFF ^ (0xFFFF >> val2);
				val |= val1 >> val2;
			} else
				val = val1 >> val2;
			if(val1 & (1 << (val2 - 1))) PS |= FLAGC;
		} else {
			val = val1 << val2;
			if(val1 & (1 << (16 - val2))) PS |= FLAGC;
		}
		R[s & 7] = val;
		if(val == 0) PS |= FLAGZ;
		if(val & 0100000) PS |= FLAGN;
		if(xor(val & 0100000, val1 & 0100000)) PS |= FLAGV;
		return;
	}
	switch(instr & 0077700) {
	case 0005000: // CLR
		PS &= 0xFFF0;
		PS |= FLAGZ;
		da = aget(d, l);
		memwrite(da, l, 0);
		return;
	case 0005100: // COM
		da = aget(d, l);
		val = memread(da, l) ^ max;
		PS &= 0xFFF0; PS |= FLAGC;
		if(val & msb) PS |= FLAGN;
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0005200: // INC
		da = aget(d, l);
		val = (memread(da, l) + 1) & max;
		PS &= 0xFFF1;
		if(val & msb) PS |= FLAGN | FLAGV;
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0005300: // DEC
		da = aget(d, l);
		val = (memread(da, l) - 1) & max;
		PS &= 0xFFF1;
		if(val & msb) PS |= FLAGN;
		if(val == maxp) PS |= FLAGV;
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0005400: // NEG
		da = aget(d, l);
		val = (-memread(da, l)) & max;
		PS &= 0xFFF0;
		if(val & msb) PS |= FLAGN;
		if(val == 0) PS |= FLAGZ;
		else PS |= FLAGC;
		if(val == 0x8000) PS |= FLAGV;
		memwrite(da, l, val);
		return;
	case 0005500: // ADC
		da = aget(d, l);
		val = memread(da, l);
		PS &= 0xFFF0;
		if(PS & FLAGC) {
			if((val + 1) & msb) PS |= FLAGN;
			if(val == max) PS |= FLAGZ;
			if(val == 0077777) PS |= FLAGV;
			if(val == 0177777) PS |= FLAGC;
			memwrite(da, l, (val+1) & max);
		} else {
			if(val & msb) PS |= FLAGN;
			if(val == 0) PS |= FLAGZ;
		}
		return;
	case 0005600: // SBC
		da = aget(d, l);
		val = memread(da, l);
		PS &= 0xFFF0;
		if(PS & FLAGC) {
			if((val - 1) & msb) PS |= FLAGN;
			if(val == 1) PS |= FLAGZ;
			if(val == 0) PS |= FLAGC;
			if(val == 0100000) PS |= FLAGV;
			memwrite(da, l, (val-1) & max);
		} else {
			if(val & msb) PS |= FLAGN;
			if(val == 0) PS |= FLAGZ;
			if(val == 0100000) PS |= FLAGV;
		}
		return;
	case 0005700: // TST
		da = aget(d, l);
		val = memread(da, l);
		PS &= 0xFFF0;
		if(val & msb) PS |= FLAGN;
		if(val == 0) PS |= FLAGZ;
		return;
	case 0006000: // ROR
		da = aget(d, l);
		val = memread(da, l);
		if(PS & FLAGC) val |= max+1;
		PS &= 0xFFF0;
		if(val & 1) PS |= FLAGC;
		if(val & (max+1)) PS |= FLAGN;
		if(!(val & max)) PS |= FLAGZ;
		if(xor(val & 1, val & (max+1))) PS |= FLAGV;
		val >>= 1;
		memwrite(da, l, val);
		return;
	case 0006100: // ROL
		da = aget(d, l);
		val = memread(da, l) << 1;
		if(PS & FLAGC) val |= 1;
		PS &= 0xFFF0;
		if(val & (max+1)) PS |= FLAGC;
		if(val & msb) PS |= FLAGN;
		if(!(val & max)) PS |= FLAGZ;
		if((val ^ (val >> 1)) & msb) PS |= FLAGV;
		val &= max;
		memwrite(da, l, val);
		return;
	case 0006200: // ASR
		da = aget(d, l);
		val = memread(da, l);
		PS &= 0xFFF0;
		if(val & 1) PS |= FLAGC;
		if(val & msb) PS |= FLAGN;
		if(xor(val & msb, val & 1)) PS |= FLAGV;
		val = (val & msb) | (val >> 1);
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0006300: // ASL
		da = aget(d, l);
		val = memread(da, l);
		PS &= 0xFFF0;
		if(val & msb) PS |= FLAGC;
		if(val & (msb >> 1)) PS |= FLAGN;
		if((val ^ (val << 1)) & msb) PS |= FLAGV;
		val = (val << 1) & max;
		if(val == 0) PS |= FLAGZ;
		memwrite(da, l, val);
		return;
	case 0006700: // SXT
		da = aget(d, l);
		if(PS & FLAGN) {
			memwrite(da, l, max);
		} else {
			PS |= FLAGZ;
			memwrite(da, l, 0);
		}
		return;
	}
	switch(instr & 0177700) {
	case 0000100: // JMP
		val = aget(d, 2);
		if(val < 0) {
			break;
		}
		R[7] = val;
		return;
	case 0000300: // SWAB
		da = aget(d, l);
		val = memread(da, l);
		val = ((val >> 8) | (val << 8)) & 0xFFFF;
		PS &= 0xFFF0;
		if((val & 0xFF) == 0) PS |= FLAGZ;
		if(val & 0x80) PS |= FLAGN;
		memwrite(da, l, val);
		return;
	}
	if((instr & 0177770) == 0000200) {
		R[7] = R[d & 7];
		R[d & 7] = pop();
		return;
	}
	if((instr & 0177077) == 0077000) {
		if(R[s & 7]--) {
			o &= 077;
			if(o & 040) {
				o = -(((~o)+1)&077);
			}
			o <<= 1;
			R[7] += o;
		}
	}
	switch(instr & 0177400) {
	case 0000400: branch(o); return;
	case 0001000: if(!(PS & FLAGZ)) branch(o); return;
	case 0001400: if(PS & FLAGZ) branch(o); return;
	case 0002000: if(!xor(PS & FLAGN, PS & FLAGV)) branch(o); return;
	case 0002400: if(xor(PS & FLAGN, PS & FLAGV)) branch(o); return;
	case 0003000: if(!xor(PS & FLAGN, PS & FLAGV) && !(PS & FLAGZ)) branch(o); return;
	case 0003400: if(xor(PS & FLAGN, PS & FLAGV) || (PS & FLAGZ)) branch(o); return;
	case 0100000: if(!(PS & FLAGN)) branch(o); return;
	case 0100400: if(PS & FLAGN) branch(o); return;
	case 0101000: if(!(PS & FLAGC) && !(PS & FLAGZ)) branch(o); return;
	case 0101400: if((PS & FLAGC) || (PS & FLAGZ)) branch(o); return;
	case 0102000: if(!(PS & FLAGV)) branch(o); return;
	case 0102400: if(PS & FLAGV) branch(o); return;
	case 0103000: if(!(PS & FLAGC)) branch(o); return;
	case 0103400: if(PS & FLAGC) branch(o); return;
	}
	panic("invalid instruction");
}

function
reset()
{
	var i;
	for(i=0;i<7;i++) R[i] = 0;
	PS = 0;
	SR0 = 0;
	curPC = 0;
	instr = 0;
	ips = 0;
	for(i=0;i<memory.length;i++) memory[i] = 0;
	for(i=0;i<bootrom.length;i++) memory[01000+i] = bootrom[i];
	R[7] = 02002;
	cleardebug();
	clearterminal();
	rkreset();
}

function
nsteps(n)
{
	while(n--) {
		step();
//		printstate();
	}
}

function
run() 
{
	if(tim1 == undefined)
		tim1 = setInterval('nsteps(1000);', 1);
	if(tim2 == undefined)
		tim2 = setInterval('document.getElementById("ips").innerHTML = ips; ips = 0;', 1000);
}

function
stop()
{
	document.getElementById("ips").innerHTML = '';
	clearInterval(tim1);
	clearInterval(tim2);
	tim1 = tim2 = undefined;
}
