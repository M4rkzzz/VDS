#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <rtc/rtc.hpp>
extern "C" int vds_test_invalid_tcp_binding(char*, size_t, const char*);
#ifdef VDS_TEST_TCP_DELAY
extern "C" __declspec(dllimport) void vds_test_tcp_delay(unsigned, unsigned);
extern "C" __declspec(dllimport) unsigned vds_test_tcp_delay_elapsed(void);
extern "C" __declspec(dllimport) unsigned vds_test_tcp_delay_withheld(void);
extern "C" __declspec(dllimport) unsigned vds_test_tcp_delay_zero_timeouts(void);
#endif
#include <cstring>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>
using namespace std::chrono_literals;
struct Pair {
 std::mutex mutex;
 std::array<std::vector<rtc::Candidate>,2> candidates;
 std::array<std::shared_ptr<rtc::PeerConnection>,2> peers;
 std::shared_ptr<rtc::DataChannel> outgoing,incoming;
 std::atomic<unsigned> echoes{0};
 std::atomic<bool> corrupt{false};
 bool stopped=false;
 ~Pair() {shutdown();}
 void shutdown() {
  if(stopped)return;stopped=true;
  if(outgoing) outgoing->resetCallbacks();
  for(auto& p:peers) if(p) {p->resetCallbacks();p->close();}
  peers={}; outgoing.reset();
  {std::lock_guard<std::mutex> lock(mutex);if(incoming) incoming->resetCallbacks();incoming.reset();}
  rtc::Cleanup().wait();
 }
};
struct SocketSet {
 std::vector<SOCKET> sockets;
 ~SocketSet() { for (auto sock:sockets) closesocket(sock); }
 SOCKET connectTo(const char* address,unsigned port,bool expectRefused=false) {
  const bool v6 = std::strchr(address, ':') != nullptr;
  SOCKET sock=socket(v6?AF_INET6:AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock==INVALID_SOCKET) throw std::runtime_error("fixture socket");
  sockets.push_back(sock);
  sockaddr_storage storage{};int length;
  if(v6) {auto& a=reinterpret_cast<sockaddr_in6&>(storage);a.sin6_family=AF_INET6;a.sin6_port=htons(static_cast<unsigned short>(port));inet_pton(AF_INET6,address,&a.sin6_addr);length=sizeof(a);}
  else {auto& a=reinterpret_cast<sockaddr_in&>(storage);a.sin_family=AF_INET;a.sin_port=htons(static_cast<unsigned short>(port));inet_pton(AF_INET,address,&a.sin_addr);length=sizeof(a);}
  int status=connect(sock,reinterpret_cast<sockaddr*>(&storage),length);
  if(expectRefused) {if(!status||WSAGetLastError()!=WSAECONNREFUSED)throw std::runtime_error("TCP listener not released");}
  else if(status)throw std::runtime_error("fixture connect");
  return sock;
 }
};
struct SilentListener {
 SOCKET sock=INVALID_SOCKET;unsigned port=0;
 SilentListener() {
  sock=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);if(sock==INVALID_SOCKET) throw std::runtime_error("silent socket");
  sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  if(bind(sock,reinterpret_cast<sockaddr*>(&address),sizeof(address))||listen(sock,SOMAXCONN)) throw std::runtime_error("silent listen");
  int length=sizeof(address);getsockname(sock,reinterpret_cast<sockaddr*>(&address),&length);port=ntohs(address.sin_port);
 }
 ~SilentListener() {if(sock!=INVALID_SOCKET)closesocket(sock);}
};
void sendFrame(SOCKET socket,const char* data,size_t size) {
 std::vector<char> wire(size+2);wire[0]=static_cast<char>(size>>8);wire[1]=static_cast<char>(size);std::memcpy(wire.data()+2,data,size);
 size_t offset=0;while(offset<wire.size()){int n=send(socket,wire.data()+offset,static_cast<int>(wire.size()-offset),0);if(n<=0)throw std::runtime_error("fixture frame send");offset+=n;}
}
void requireClosed(SOCKET socket) {
 pollfd pfd{socket,POLLIN,0};if(WSAPoll(&pfd,1,2000)<=0)throw std::runtime_error("invalid connection was not closed");
 char byte;int n=recv(socket,&byte,1,0);
 if(n>0||(n<0&&WSAGetLastError()!=WSAECONNRESET&&WSAGetLastError()!=WSAECONNABORTED))throw std::runtime_error("invalid connection was accepted");
}
bool run(const char* address,bool tcp,int passiveSide=-1,bool noise=false,bool badFirst=false,bool mapped=false,bool simultaneous=false,unsigned signalingDelay=0,int delayedSide=1,bool staleSo=false,const char* otherAddress=nullptr) {
 std::cout<<"CASE address="<<address<<" tcp="<<tcp<<" passiveSide="<<passiveSide<<" noise="<<noise<<" badFirst="<<badFirst<<" so="<<simultaneous<<" signalingDelayMs="<<signalingDelay<<" delayedSide="<<delayedSide<<" staleSo="<<staleSo<<std::endl;
 SocketSet interference;
 std::vector<SOCKET> idleSockets;
 std::array<unsigned,2> listenerPorts{},soPorts{};
 std::array<SilentListener,2> silent;

 Pair pair;
 const std::array<const char*,2> bindAddresses{address,otherAddress?otherAddress:address};
 for(unsigned side=0;side<2;++side) {
  rtc::Configuration config; config.bindAddress=bindAddresses[side];config.enableIceTcp=tcp;
  config.disableAutoGathering=true;config.disableAutoNegotiation=true;
  pair.peers[side]=std::make_shared<rtc::PeerConnection>(config);
  pair.peers[side]->onLocalCandidate([&,side](rtc::Candidate c) {
   if((c.transportType()!=rtc::Candidate::TransportType::Udp)!=tcp) return;
   std::lock_guard<std::mutex> lock(pair.mutex);pair.candidates[side].push_back(c);
  });
 }
 pair.peers[1]->onDataChannel([&](std::shared_ptr<rtc::DataChannel> c) {
  std::weak_ptr<rtc::DataChannel> weak=c;
  c->onMessage([weak](rtc::message_variant message){if(auto active=weak.lock()) active->send(message);});
  std::lock_guard<std::mutex> lock(pair.mutex);pair.incoming=c;
 });
 pair.outgoing=pair.peers[0]->createDataChannel("tcp-only-acceptance");
 const std::string payload(4096,'t');
 pair.outgoing->onMessage([&](rtc::message_variant message) {if(auto p=std::get_if<std::string>(&message);p && *p==payload+std::to_string(pair.echoes.load())) ++pair.echoes;else pair.corrupt=true;});
 pair.peers[0]->setLocalDescription(rtc::Description::Type::Offer);
 auto offer=*pair.peers[0]->localDescription();
 if(!offer.candidates().empty()) throw std::runtime_error("unexpected early candidate bypass");
 pair.peers[1]->setRemoteDescription(offer);pair.peers[1]->setLocalDescription(rtc::Description::Type::Answer);
 auto answer=*pair.peers[1]->localDescription();
 if(!answer.candidates().empty()) throw std::runtime_error("unexpected answer candidate bypass");
 pair.peers[0]->setRemoteDescription(answer);
 for(auto& p:pair.peers) p->gatherLocalCandidates();
 std::array<std::vector<rtc::Candidate>,2> signaled;
 const auto gathered=std::chrono::steady_clock::now()+3s;
 while(std::chrono::steady_clock::now()<gathered) {
  {std::lock_guard<std::mutex> lock(pair.mutex); signaled=pair.candidates;}
  if(!signaled[0].empty()&&!signaled[1].empty()&&(!tcp ||
     (std::any_of(signaled[0].begin(),signaled[0].end(),[](const auto& c){return c.transportType()==rtc::Candidate::TransportType::TcpPassive;})&&
      std::any_of(signaled[1].begin(),signaled[1].end(),[](const auto& c){return c.transportType()==rtc::Candidate::TransportType::TcpPassive;})))) break;
  std::this_thread::sleep_for(5ms);
 }
 if(tcp) for(unsigned side=0;side<2;++side) {
  for(auto candidate:signaled[side]) if(candidate.transportType()==rtc::Candidate::TransportType::TcpPassive) {
   if(!candidate.resolve()||!candidate.port())throw std::runtime_error("passive listener unresolved");listenerPorts[side]=*candidate.port();
  }
  if(!listenerPorts[side])throw std::runtime_error("missing passive listener");
 }
 if(simultaneous) for(unsigned side=0;side<2;++side) {
  auto& list=signaled[side];
  list.erase(std::remove_if(list.begin(),list.end(),[](const auto& c){return c.transportType()!=rtc::Candidate::TransportType::TcpSo;}),list.end());
  if(list.size()!=1||!list.front().resolve()||!list.front().port())throw std::runtime_error("missing unique SO candidate");
  soPorts[side]=*list.front().port();
  if(soPorts[side]==listenerPorts[side])throw std::runtime_error("SO shared passive listener");
 }
 if(!simultaneous) for(auto& list:signaled)
  list.erase(std::remove_if(list.begin(),list.end(),[](const auto& c){return c.transportType()==rtc::Candidate::TransportType::TcpSo;}),list.end());
 if(tcp && noise) {
  for(unsigned side=0;side<2;++side) {
   auto passive=std::find_if(signaled[side].begin(),signaled[side].end(),[](const auto& c){return c.transportType()==rtc::Candidate::TransportType::TcpPassive;});
   if(passive==signaled[side].end()||!passive->resolve()||!passive->port())throw std::runtime_error("passive listener missing");
   for(unsigned i=0;i<65;++i) idleSockets.push_back(interference.connectTo(address,*passive->port()));
   SOCKET malformed=interference.connectTo(address,*passive->port());sendFrame(malformed,"invalid",7);requireClosed(malformed);
   SOCKET invalid=interference.connectTo(address,*passive->port());
   const auto user=*pair.peers[side]->localDescription()->iceUfrag()+":"+*pair.peers[1-side]->localDescription()->iceUfrag();
   char wire[2048];int size=vds_test_invalid_tcp_binding(wire,sizeof(wire),user.c_str());
   if(size<=0)throw std::runtime_error("invalid credential fixture");sendFrame(invalid,wire,size);requireClosed(invalid);
  }
  if(pair.outgoing->isOpen())throw std::runtime_error("unauthenticated connection opened DataChannel");
 }
 if(tcp && passiveSide>=0) {
  const unsigned omitted=1-static_cast<unsigned>(passiveSide);
  auto& list=signaled[omitted];
  list.erase(std::remove_if(list.begin(),list.end(),[](const auto& c){return c.transportType()==rtc::Candidate::TransportType::TcpPassive;}),list.end());
 }
 if(staleSo) for(unsigned side=0;side<2;++side) {
  // Bound but not listening: cannot rescue with an active/passive connection.
  SOCKET sock=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
  if(sock==INVALID_SOCKET)throw std::runtime_error("stale SO fixture socket");
  interference.sockets.push_back(sock);
  sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  if(bind(sock,reinterpret_cast<sockaddr*>(&a),sizeof(a)))throw std::runtime_error("stale SO fixture bind");
  int length=sizeof(a);if(getsockname(sock,reinterpret_cast<sockaddr*>(&a),&length))throw std::runtime_error("stale SO getsockname");
  signaled[side].insert(signaled[side].begin(),rtc::Candidate("candidate:stale 1 TCP 2000000000 127.0.0.1 "+std::to_string(ntohs(a.sin_port))+" typ host tcptype so",signaled[side].front().mid()));
 }
 unsigned mappedPort=0;std::string mappedAddress;
 if(mapped) {
  std::cout<<"MAP_LISTENER "<<listenerPorts[0]<<std::endl;
  std::string line;if(!std::getline(std::cin,line))throw std::runtime_error("mapped candidate missing");
  rtc::Candidate candidate(line,signaled[0].front().mid());
  if(!candidate.resolve()||!candidate.port()||candidate.type()!=rtc::Candidate::Type::ServerReflexive||
     candidate.transportType()!=rtc::Candidate::TransportType::TcpPassive)throw std::runtime_error("invalid mapped candidate");
  mappedPort=*candidate.port();mappedAddress=*candidate.address();
#ifdef VDS_TEST_TCP_DELAY
  vds_test_tcp_delay(mappedPort,5000);
#endif
  if(mappedPort==listenerPorts[0]&&mappedAddress==address)throw std::runtime_error("mapping did not translate endpoint");
  signaled[0]={candidate};
 }
 if(tcp && badFirst) {
  for(unsigned side=0;side<2;++side) {
   signaled[side].insert(signaled[side].begin(),rtc::Candidate("candidate:silent 1 TCP 2000000000 127.0.0.1 "+std::to_string(silent[side].port)+" typ host tcptype passive",signaled[side].front().mid()));
  }
 }
 for(unsigned order=0;order<2;++order) {
  unsigned side=signalingDelay?(order?delayedSide:1-delayedSide):order;
  if(order&&signalingDelay)std::this_thread::sleep_for(std::chrono::milliseconds(signalingDelay));
  if(signaled[side].empty()) throw std::runtime_error("no requested transport candidates gathered");
  for(auto& c:signaled[side]) {std::cout<<"CANDIDATE "<<address<<" side="<<side<<" "<<c.candidate()<<std::endl;pair.peers[1-side]->addRemoteCandidate(c);}
 }
 const auto connectStart=std::chrono::steady_clock::now();
#ifdef VDS_TEST_TCP_DELAY
 const auto deadline=connectStart+14s;
#else
 const auto deadline=connectStart+5s;
#endif
 while(!pair.outgoing->isOpen()&&std::chrono::steady_clock::now()<deadline) std::this_thread::sleep_for(5ms);
#ifdef VDS_TEST_TCP_DELAY
 std::cout<<"FAULT pollHeld="<<vds_test_tcp_delay_elapsed()<<" withheld="<<vds_test_tcp_delay_withheld()<<" zeroTimeouts="<<vds_test_tcp_delay_zero_timeouts()<<std::endl;
#endif
 if(!pair.outgoing->isOpen()) {std::cout<<"FAIL direct "<<(tcp?"TCP":"UDP")<<" "<<address<<" DataChannel never opened; no UDP candidate signaled in TCP case"<<std::endl;return false;}
#ifdef VDS_TEST_TCP_DELAY
 const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-connectStart).count();
 std::cout<<"DELAY completed="<<elapsed<<" pollHeld="<<vds_test_tcp_delay_elapsed()<<" withheld="<<vds_test_tcp_delay_withheld()<<std::endl;
 if(vds_test_tcp_delay_elapsed()<5000||!vds_test_tcp_delay_withheld()||elapsed<8500)
  throw std::runtime_error("late-connect fault was not exercised");
 if(vds_test_tcp_delay_withheld()<4||vds_test_tcp_delay_zero_timeouts()>=vds_test_tcp_delay_withheld()/2)
  throw std::runtime_error("pending TCP repeatedly requested zero-timeout polling");
#endif
 const auto until=std::chrono::steady_clock::now()+(tcp?7s:2s);
 while(std::chrono::steady_clock::now()<until) {
  const auto before=pair.echoes.load();pair.outgoing->send(payload+std::to_string(before));
  const auto reply=std::chrono::steady_clock::now()+500ms;
  while(pair.echoes==before&&std::chrono::steady_clock::now()<reply) std::this_thread::sleep_for(5ms);
  if(pair.echoes==before||pair.corrupt) throw std::runtime_error("echo stalled, corrupted, duplicated or reordered");
  std::this_thread::sleep_for(20ms);
 }
 for(unsigned side=0;side<2;++side) {
  rtc::Candidate local,remote;
  if(!pair.peers[side]->getSelectedCandidatePair(&local,&remote)||
     ((remote.transportType()!=rtc::Candidate::TransportType::Udp)!=tcp)||
     ((local.transportType()!=rtc::Candidate::TransportType::Udp)!=tcp)||
     remote.type()==rtc::Candidate::Type::Relayed||local.type()==rtc::Candidate::Type::Relayed)
   throw std::runtime_error("wrong transport rescued test: local="+local.candidate()+" remote="+remote.candidate());
  if(otherAddress && (!local.resolve()||local.address()!=bindAddresses[side]))
   throw std::runtime_error("TCP ignored configured source address: expected="+std::string(bindAddresses[side])+" local="+local.candidate());
  if(!remote.resolve()||remote.address()!=(mapped&&side==1?mappedAddress:bindAddresses[1-side]))throw std::runtime_error("non-loopback route rescued test: remote="+remote.candidate());
  if(mapped&&side==1&&(remote.port()!=mappedPort||remote.type()!=rtc::Candidate::Type::ServerReflexive))
   throw std::runtime_error("unmapped candidate rescued TCP mapping test");
  if(simultaneous && (!local.resolve()||local.transportType()!=rtc::Candidate::TransportType::TcpSo||
      remote.transportType()!=rtc::Candidate::TransportType::TcpSo||local.port()!=soPorts[side]||remote.port()!=soPorts[1-side]))
   throw std::runtime_error("SO source endpoint changed or another role rescued test: local="+local.candidate()+" remote="+remote.candidate());
  std::cout<<"SELECTED side="<<side<<" local="<<local.candidate()<<" remote="<<remote.candidate()<<std::endl;
 }
 if(badFirst) for(auto& listener:silent) {
  u_long nbio=1;ioctlsocket(listener.sock,FIONBIO,&nbio);
  SOCKET accepted=accept(listener.sock,nullptr,nullptr);
  if(accepted==INVALID_SOCKET)throw std::runtime_error("silent first candidate never attempted");
  closesocket(accepted);
 }
 const unsigned total=pair.echoes.load();
 pair.shutdown();
 if(tcp) for(unsigned side=0;side<2;++side) interference.connectTo(bindAddresses[side],listenerPorts[side],true);
 for(auto idle:idleSockets)requireClosed(idle);
 std::cout<<"PASS direct "<<(tcp?"TCP":"UDP")<<" "<<address<<" echo4KiB="<<total<<" cleanup=true"<<std::endl;return true;
}
void candidateAttributeTests() {
 const std::string prefix="candidate:m 1 TCP 100 127.0.0.1 12345 typ srflx ";
 for(const char* tail:{"tcptype passive", "raddr 10.0.0.1 rport 5555 tcptype passive", "network-id 1 raddr 10.0.0.1 rport 5555 tcptype passive ufrag abcd"})
  if(rtc::Candidate(prefix+tail).transportType()!=rtc::Candidate::TransportType::TcpPassive)throw std::runtime_error("TCP related-address attribute parse failed");
 for(const char* tail:{"wrong passive", "value tcptype passive", "tcptype passive tcptype active", "tcptype unknown", "raddr 10.0.0.1 rport 5555"})
  if(rtc::Candidate(prefix+tail).transportType()!=rtc::Candidate::TransportType::TcpUnknown)throw std::runtime_error("invalid TCP type attribute accepted");
 std::cout<<"PASS TCP candidate attribute parsing: 8 cases"<<std::endl;
}
int main(int argc,char** argv) {
 WSADATA wsa{};if(WSAStartup(MAKEWORD(2,2),&wsa)) return 2;
 struct WsaCleanup { ~WsaCleanup(){WSACleanup();} } cleanup;
 rtc::InitLogger(rtc::LogLevel::Warning);
 try {candidateAttributeTests();
 if(argc==2&&std::string(argv[1])=="--active-bind") {
  bool ok=run("127.0.0.2",true,1,false,false,false,false,0,1,false,"127.0.0.3");
  ok=run("127.0.0.2",true,0,false,false,false,false,0,1,false,"127.0.0.3")&&ok;
  return ok?0:1;
 }
 if(argc==2&&std::string(argv[1])=="--simultaneous-edge") {
  bool ok=run("127.0.0.1",true,-1,false,false,false,true,250,0);
  ok=run("127.0.0.1",true,-1,false,false,false,true,1000,1)&&ok;
  ok=run("::1",true,-1,false,false,false,true,250,1)&&ok;
  ok=run("127.0.0.1",true,-1,false,false,false,true,0,1,true)&&ok;return ok?0:1;
 }
 if(argc==2&&std::string(argv[1])=="--simultaneous-tcp") {
  bool ok=run("127.0.0.1",true,-1,false,false,false,true);
  ok=run("::1",true,-1,false,false,false,true)&&ok;return ok?0:1;
 }
if(argc==2&&std::string(argv[1])=="--mapped-tcp")return run("127.0.0.1",true,0,false,false,true)?0:1;bool ok=run("127.0.0.1",false);ok=run("127.0.0.1",true)&&ok;ok=run("::1",true)&&ok;ok=run("127.0.0.1",true,0)&&ok;ok=run("127.0.0.1",true,1)&&ok;ok=run("127.0.0.1",true,-1,true,true)&&ok;return ok?0:1;}
 catch(const std::exception& e){std::cerr<<"ERROR "<<e.what()<<std::endl;return 2;}
}
