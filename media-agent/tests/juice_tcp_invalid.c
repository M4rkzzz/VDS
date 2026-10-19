#include "stun.h"
#include <string.h>

int vds_test_invalid_tcp_binding(char *output, size_t capacity, const char *username) {
 stun_message_t msg;
 memset(&msg, 0, sizeof(msg));
 msg.msg_method = STUN_METHOD_BINDING;
 msg.msg_class = STUN_CLASS_REQUEST;
 msg.has_integrity = true;
 msg.priority = 1234;
 msg.ice_controlling = 123456;
 if (strlen(username) >= sizeof(msg.credentials.username)) return -1;
 strcpy(msg.credentials.username, username);
 return _juice_stun_write(output, capacity, &msg, "deliberately-wrong-key");
}
